import type { Transaction } from "@libellum/shared";

/**
 * Working out what two copies of one entry disagree about.
 *
 * ⚠️ **The owner set the rule before any of this existed**: "先自动合并：不冲突的字段自动合，只有冲突的字段才问"
 * — and, in the same breath, **"但'自动合了哪些'必须显示出来，否则用户不知道机器替他决定了什么."**
 *
 * Both halves are here, and they matter equally:
 *
 * | Situation | What happens |
 * |---|---|
 * | only one side changed the field | taken from that side — **there is nothing to ask** |
 * | both changed it, differently | **the user is asked**, because only they know which is right |
 * | neither changed it | nothing happens |
 *
 * ⚠️ **"Only one side changed it" is decided against the version both sides started from.** Without that base,
 * "changed" is unknowable and every difference becomes a question — **which is the version of this feature that
 * makes the user do work the program could have done.**
 *
 * ⚠️ **Every automatic decision is reported, not just applied.** "It merged four fields for you" is something
 * the user is entitled to see, and **a silent merge is indistinguishable from the program losing their edit.**
 */

/** The fields that can differ, named as the screens name them. */
export type MergeField =
  | "kind"
  | "amountCents"
  | "currency"
  | "categoryId"
  | "paymentMethodId"
  | "occurredAt"
  | "note"
  | "tags";

/** One field the two sides disagree about, ready for the user to choose. */
export interface FieldConflict {
  readonly field: MergeField;
  /** The label a person reads — kept here so a second table cannot drift from this one. */
  readonly label: string;
  readonly mine: unknown;
  readonly theirs: unknown;
  readonly base: unknown;
}

/** One field that was settled automatically, so the user can see what was decided for them. */
export interface AutomaticPick {
  readonly field: MergeField;
  readonly label: string;
  /** Which side the value came from. */
  readonly from: "mine" | "theirs";
  readonly value: unknown;
}

export interface MergeResult {
  /** The entry as it stands with every automatic decision applied. */
  readonly merged: Transaction;
  /** Fields only one side changed. **Shown to the user, never hidden.** */
  readonly automatic: readonly AutomaticPick[];
  /** Fields both sides changed, differently. **These are the questions.** */
  readonly conflicts: readonly FieldConflict[];
}

export const FIELD_LABELS: Record<MergeField, string> = {
  kind: "收支",
  amountCents: "金额",
  currency: "币种",
  categoryId: "分类",
  paymentMethodId: "支付方式",
  occurredAt: "时间",
  note: "备注",
  tags: "标签",
};

/**
 * The fields compared, in the order a person reads a receipt.
 *
 * ⚠️ **`categoryName` and `paymentMethodName` are deliberately absent.** The server denormalises them onto each
 * entry so they follow their ids — **comparing them too would report a renamed category as a second conflict
 * beside the change to the category itself**, and the user would be asked twice about one decision.
 *
 * ⚠️ **`version` is absent for the same reason**: it is the mechanism, not something the user edits.
 */
const FIELDS: readonly MergeField[] = [
  "kind",
  "amountCents",
  "currency",
  "categoryId",
  "paymentMethodId",
  "occurredAt",
  "note",
  "tags",
];

/** A comparable form of one field: tags become their ids, everything else is itself. */
function valueOf(entry: Transaction, field: MergeField): unknown {
  return field === "tags" ? entry.tags.map((tag) => tag.id) : entry[field];
}

/** Whether two field values are the same, with tags compared as sets rather than as sequences. */
function same(field: MergeField, left: unknown, right: unknown): boolean {
  if (field !== "tags") return left === right;

  const a = Array.isArray(left) ? [...(left as string[])].sort() : [];
  const b = Array.isArray(right) ? [...(right as string[])].sort() : [];

  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Merge what this device has with what the server has.
 *
 * @param base the version both sides started from, **or `null` when it is not known**
 */
export function mergeEntries(
  base: Transaction | null,
  mine: Transaction,
  theirs: Transaction,
): MergeResult {
  const automatic: AutomaticPick[] = [];
  const conflicts: FieldConflict[] = [];

  /** ⚠️ Starts as the server's copy, so nothing the user cannot edit is at risk of being lost. */
  const values: Partial<Record<MergeField, unknown>> = {};

  for (const field of FIELDS) {
    const myValue = valueOf(mine, field);
    const theirValue = valueOf(theirs, field);

    /** They agree. Nothing to decide, and nothing to report. */
    if (same(field, myValue, theirValue)) continue;

    /**
     * ⚠️ **With no base, every difference has to be a question.**
     *
     * `base === null` means this device never held the version the server started from — a mark that outlived the
     * entry's history, or a conflict noticed after a reinstall. **Guessing would silently discard one side's
     * work**, and the only thing worse than asking too much is deciding wrongly without asking.
     */
    if (base === null) {
      conflicts.push({ field, label: FIELD_LABELS[field], mine: myValue, theirs: theirValue, base: null });
      continue;
    }

    const baseValue = valueOf(base, field);
    const iChanged = !same(field, myValue, baseValue);
    const theyChanged = !same(field, theirValue, baseValue);

    /**
     * ⚠️ **Only they changed it, so theirs stands.** Overwriting a value the user never touched is exactly how a
     * sync loses somebody else's edit — **and the user would have no way to know it happened.**
     */
    if (!iChanged && theyChanged) {
      automatic.push({ field, label: FIELD_LABELS[field], from: "theirs", value: theirValue });
      continue;
    }

    /** ⚠️ Only I changed it, so mine stands. **This is the ordinary offline edit**, and it is not a question. */
    if (iChanged && !theyChanged) {
      automatic.push({ field, label: FIELD_LABELS[field], from: "mine", value: myValue });
      values[field] = myValue;
      continue;
    }

    /**
     * ⚠️ **Both changed it, differently — the only case the user is asked about.**
     *
     * Everything above exists to keep this question to the cases where it is genuinely theirs to answer.
     */
    conflicts.push({ field, label: FIELD_LABELS[field], mine: myValue, theirs: theirValue, base: baseValue });
  }

  return {
    merged: compose(theirs, mine, values, automatic),
    automatic,
    conflicts,
  };
}

/**
 * Build the merged entry.
 *
 * ⚠️ **It is assembled field by field from a base of the server's copy**, rather than by spreading one side over
 * the other. Spreading would silently carry across fields that were never compared — **and "never compared" is
 * how a value quietly wins an argument nobody had.**
 */
function compose(
  theirs: Transaction,
  mine: Transaction,
  values: Partial<Record<MergeField, unknown>>,
  automatic: readonly AutomaticPick[],
): Transaction {
  /** Which side each field ended up coming from, so the denormalised names can follow their ids. */
  const from = new Map<MergeField, "mine" | "theirs">();

  for (const pick of automatic) from.set(pick.field, pick.from);

  const categorySide = from.get("categoryId") ?? "theirs";
  const methodSide = from.get("paymentMethodId") ?? "theirs";
  const tagSource = from.get("tags") === "mine" ? mine : theirs;

  return {
    ...theirs,
    kind: (values["kind"] ?? theirs.kind) as Transaction["kind"],
    amountCents: (values["amountCents"] ?? theirs.amountCents) as number,
    currency: (values["currency"] ?? theirs.currency) as Transaction["currency"],
    categoryId: (values["categoryId"] ?? theirs.categoryId) as string,
    /**
     * ⚠️ **The name follows the id**, because a merged entry that kept the other side's category *name* would
     * show a category it does not have — **and the screen would be lying about the one field the user changed.**
     */
    categoryName: categorySide === "mine" ? mine.categoryName : theirs.categoryName,
    categoryIsSystem: categorySide === "mine" ? mine.categoryIsSystem : theirs.categoryIsSystem,
    paymentMethodId: (values["paymentMethodId"] ?? theirs.paymentMethodId) as string | null,
    paymentMethodName: methodSide === "mine" ? mine.paymentMethodName : theirs.paymentMethodName,
    occurredAt: (values["occurredAt"] ?? theirs.occurredAt) as string,
    note: (values["note"] ?? theirs.note) as string | null,
    tags: tagSource.tags,
  };
}

/**
 * The entry with the user's answers applied, after `mergeEntries`.
 *
 * ⚠️ **An unanswered conflict keeps the server's value**, because that is what every other device already
 * agrees with — **and a screen that asked and then applied neither side would be worse than not asking.**
 */
export function applyAnswers(
  merged: Transaction,
  answers: ReadonlyMap<MergeField, "mine" | "theirs">,
  mine: Transaction,
  theirs: Transaction,
): Transaction {
  const result = { ...merged };

  for (const [field, side] of answers) {
    const source = side === "mine" ? mine : theirs;

    if (field === "tags") {
      result.tags = source.tags;
      continue;
    }

    (result as unknown as Record<string, unknown>)[field] = valueOf(source, field);
  }

  /** ⚠️ The names follow their ids again, for an answered category or payment method. */
  const categorySide = answers.get("categoryId") ?? "theirs";

  result.categoryName = categorySide === "mine" ? mine.categoryName : theirs.categoryName;
  result.categoryIsSystem = categorySide === "mine" ? mine.categoryIsSystem : theirs.categoryIsSystem;

  const methodSide = answers.get("paymentMethodId") ?? "theirs";

  result.paymentMethodName = methodSide === "mine" ? mine.paymentMethodName : theirs.paymentMethodName;

  return result;
}
