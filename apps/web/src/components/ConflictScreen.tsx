import type { Transaction } from "@libellum/shared";
import { useMemo, useState } from "react";

import { Button } from "./Button.js";
import { formatMoney } from "../lib/format.js";
import { applyAnswers, mergeEntries, type AutomaticPick, type MergeField } from "../lib/offline/merge.js";
import type { ConflictRecord } from "../lib/offline/localLedger.js";

/**
 * The screen where the user settles a conflict.
 *
 * ⚠️ **The owner set both halves of this rule up front**: "先自动合并：不冲突的字段自动合，只有冲突的字段才问"
 * and **"但'自动合了哪些'必须显示出来，否则用户不知道机器替他决定了什么."**
 *
 * **The second half is the part that is easy to leave out and expensive to omit.**
 *
 * A screen that only asks about the conflicting fields looks like the program did the rest *by guessing*. **The
 * user cannot tell "it merged four fields for me" from "it dropped three of my edits"** — both look like a form
 * with one question and a Save button. So the automatic decisions are listed explicitly, with the side each value
 * came from, **and nothing is applied until the user confirms.**
 *
 * ⚠️ **Nothing here writes.** It reports the outcome; the caller decides what to do with it — which keeps this
 * screen testable as a pure description of a merge.
 */

interface ConflictScreenProps {
  readonly conflict: ConflictRecord;
  /** Called with the settled entry when the user accepts the result. */
  readonly onResolve: (settled: Transaction) => void;
  /** Called when the user would rather do this later. */
  readonly onLater: () => void;
  /**
   * ⚠️ **Names for the ids, because a conflict about `01a128…` is a conflict nobody can answer.**
   *
   * The owner's report: "在冲突页面，分类并不会显示成文字，而是一串代码." **The entry carries the category name, but a
   * conflict value is a bare id from the server** — so the screen has to be told what the ids are called.
   */
  readonly categories?: readonly { readonly id: string; readonly name: string }[] | undefined;
  readonly paymentMethods?: readonly { readonly id: string; readonly name: string }[] | undefined;
  readonly tags?: readonly { readonly id: string; readonly name: string }[] | undefined;
}

/** The names a value can be looked up by, when it is an id. */
interface Names {
  /** ⚠️ `| undefined` is explicit because `exactOptionalPropertyTypes` is on, and the props are optional. */
  readonly categories?: readonly { readonly id: string; readonly name: string }[] | undefined;
  readonly paymentMethods?: readonly { readonly id: string; readonly name: string }[] | undefined;
  readonly tags?: readonly { readonly id: string; readonly name: string }[] | undefined;
}

/** How a value is shown. Amounts are money, ids become names, everything else prints itself. */
function describe(field: MergeField, value: unknown, names: Names = {}): string {
  if (field === "amountCents") return formatMoney(Number(value), "CNY");

  if (field === "kind") return value === "income" ? "收入" : "支出";

  if (field === "note") return value === null || value === "" ? "（空）" : String(value);

  if (field === "currency") return String(value);

  /**
   * ⚠️ **An id is shown as its name, and as the id only when the name is unknown.**
   *
   * The owner's report: "在冲突页面，分类并不会显示成文字，而是一串代码." **A conflict about `01a128…` is a conflict
   * nobody can answer.** Falling back to the raw string keeps the screen honest about something the ledger does not
   * list, **rather than showing an empty choice or inventing a label.**
   */
  if (field === "categoryId") {
    return names.categories?.find((item) => item.id === value)?.name ?? String(value);
  }

  if (field === "paymentMethodId") {
    if (value === null) return "（无）";

    return names.paymentMethods?.find((item) => item.id === value)?.name ?? String(value);
  }

  if (field === "tags") {
    const ids = Array.isArray(value) ? (value as string[]) : [];

    if (ids.length === 0) return "（无标签）";

    return ids.map((id) => names.tags?.find((item) => item.id === id)?.name ?? id).join("、");
  }

  return value === null || value === undefined ? "（空）" : String(value);
}

/** The side a field came from, in words. */
function sideLabel(from: "mine" | "theirs"): string {
  return from === "mine" ? "用你的" : "用服务器上的";
}

export function ConflictScreen({ conflict, onResolve, onLater, categories, paymentMethods, tags }: ConflictScreenProps): React.JSX.Element {
  const merged = useMemo(
    () => mergeEntries(conflict.base, conflict.mine, conflict.theirs),
    [conflict.base, conflict.mine, conflict.theirs],
  );

  /**
   * ⚠️ **Every conflict starts unanswered, and an unanswered one keeps the server's value.** Defaulting to
   * "mine" would make the common case — tapping through quickly — silently overwrite the other device, which is
   * the exact outcome this screen exists to prevent.
   */
  const [answers, setAnswers] = useState<ReadonlyMap<MergeField, "mine" | "theirs">>(new Map());

  const settled = useMemo(
    () => applyAnswers(merged.merged, answers, conflict.mine, conflict.theirs),
    [merged.merged, answers, conflict.mine, conflict.theirs],
  );

  /**
   * ⚠️ **Only the fields the server named are asked about**, and the rest of the merge is applied silently.
   *
   * The rule is the owner's — **"只有在服务器的数值是 C，而某台设备上传的请求是把数字从 A 改成 B 时才会触发冲突
   * 机制"** — and **only the server can apply it**, because only it knows whether the value this device read has
   * moved. A field the server accepted is already saved there, **so asking about it would be asking the user to
   * re-decide something that is not in question.**
   */
  const questions = useMemo(() => {
    const named = conflict.fields;

    if (named === undefined || named.length === 0) return merged.conflicts;

    const byField = new Map(merged.conflicts.map((item) => [item.field, item]));

    return named
      .map((item) => byField.get(item.field as MergeField))
      .filter((item): item is (typeof merged.conflicts)[number] => item !== undefined);
  }, [conflict.fields, merged.conflicts]);

  const unanswered = questions.filter((field) => !answers.has(field.field)).length;

  return (
    <div className="flex flex-col gap-5 px-6 py-5">
        <p className="text-sm leading-relaxed text-muted">
          这台设备上的改动和服务器上的不同。<strong className="text-ink">没冲突的地方已经自动合好了</strong>
          ，下面列出来给你看一眼；只有两边都改过、而且改得不一样的地方才需要你选。
        </p>

        {/*
          ⚠️ **The automatic part is shown first, before any question is asked.**

          Putting the questions first and the decisions in a footnote would make the merge feel like a black box
          that occasionally interrupts. **The user should see what the program already settled before being asked
          to settle anything themselves** — and if one of those decisions looks wrong, that is information they
          need before answering the rest.
        */}
        {merged.automatic.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h2 className="text-xs text-muted">已经自动合好的地方（{merged.automatic.length} 处）</h2>

            <ul className="overflow-hidden rounded-card border border-line bg-surface">
              {merged.automatic.map((pick: AutomaticPick) => (
                <li
                  key={pick.field}
                  className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-2.5 text-sm last:border-b-0"
                >
                  <span className="text-muted">{pick.label}</span>
                  <span className="text-right">
                    <span className="text-ink">{describe(pick.field, pick.value, { categories, paymentMethods, tags })}</span>
                    {/*
                      ⚠️ **Which side it came from is the point.** "金额 → ¥25.00" without "用你的" leaves the user
                      unable to tell whether their edit survived — **and that question is the whole reason this
                      list exists.**
                    */}
                    <span className="ml-2 text-xs text-muted">{sideLabel(pick.from)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <p className="text-xs text-muted">没有需要自动合并的字段。</p>
        )}

        <section className="flex flex-col gap-2">
          <h2 className="text-xs text-muted">需要你选的地方（{questions.length} 处）</h2>

          {questions.map((field) => {
            const chosen = answers.get(field.field);
            const options = [
              { side: "mine" as const, label: "这台设备", value: field.mine },
              { side: "theirs" as const, label: "服务器", value: field.theirs },
            ];

            return (
              <div key={field.field} className="rounded-card border border-line bg-surface px-4 py-3">
                <p className="text-sm text-ink">{field.label}</p>

                <div className="mt-2 flex flex-col gap-2">
                  {options.map((option) => (
                    <button
                      key={option.side}
                      type="button"
                      onClick={() => {
                        const next = new Map(answers);
                        next.set(field.field, option.side);
                        setAnswers(next);
                      }}
                      aria-pressed={chosen === option.side}
                      className={`flex items-baseline justify-between gap-3 rounded-field border px-3 py-2 text-left text-sm transition ${
                        chosen === option.side
                          ? "border-brand bg-brand-soft text-ink"
                          : "border-line bg-canvas text-muted hover:border-brand"
                      }`}
                    >
                      <span className="text-xs">{option.label}</span>
                      <span className={chosen === option.side ? "text-ink" : ""}>
                        {describe(field.field, option.value, { categories, paymentMethods, tags })}
                      </span>
                    </button>
                  ))}
                </div>

                {/*
                  ⚠️ **A default is stated rather than hidden.** Leaving a field unanswered keeps the server's
                  value, and the user is told so instead of discovering it in the result.
                */}
                {chosen === undefined ? (
                  <p className="mt-2 text-xs text-muted">选一个；不选就先用服务器上的。</p>
                ) : null}
              </div>
            );
          })}
        </section>

        <section className="flex flex-col gap-2">
          <Button
            disabled={unanswered > 0}
            onClick={() => {
              onResolve(settled);
            }}
          >
            {unanswered > 0 ? `还有 ${String(unanswered)} 处没选` : "用这个结果保存"}
          </Button>

          <Button
            variant="ghost"
            onClick={() => {
              onLater();
            }}
          >
            稍后再处理
          </Button>

          <p className="text-xs leading-relaxed text-muted">
            保存后这笔记账会按上面的结果重新送到服务器。
            「稍后再处理」不会丢东西——两份都留着，下次打开还会问你。
          </p>
      </section>
    </div>
  );
}
