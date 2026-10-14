import {
  CURRENCIES,
  MAX_TAGS_PER_TRANSACTION,
  decimalsFor,
  type Currency,
  type Transaction,
  type TransactionKind,
} from "@libellum/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";

import { Alert } from "../components/Alert.js";
import { EntrySaved } from "../components/EntrySaved.js";
import { InfoIcon } from "../components/InfoHint.js";
import { TabPage } from "../components/Layouts.js";
import { errorMessage } from "../lib/api.js";
import {
  fromDateTimeLocalValue,
  localTimeZone,
  toDateTimeLocalValue,
  toLocalDate,
  toLocalIso,
} from "../lib/datetime.js";
import { amountPlaceholder, currencyName, minorToInput, parseAmountInput } from "../lib/format.js";
import { createEntry as createLocally, localEntry } from "../lib/offline/write.js";
import { useCreateTransaction, useLedger, useQuickAmounts, useTransactions } from "../lib/queries.js";
import { uuidV7 } from "../lib/uuid.js";

/** Shown when there is nothing to inherit and nothing named 其他 to fall back on. */
const UNCATEGORISED_LABEL = "暂无分类";
const DEFAULT_PAYMENT_METHOD_NAME = "其他";

/**
 * The screen the whole application exists for.
 *
 * Two defaults matter here. A category starts at 暂无分类 and a payment method
 * at 其他, so a first entry can be saved without opening either control. Once
 * there is history the category, the payment method and the currency follow the
 * previous entry instead, which is what makes recording a day's receipts quick.
 *
 * The *date* never follows anything. Every entry starts at the current time:
 * the first one on a freshly opened screen, and equally the one after the
 * "再记一笔" button. Inheriting a date from an older entry would silently file
 * today's spending under the wrong day — and because the stale value stays
 * visible in the field, nothing on the screen would look wrong.
 *
 * Editing an existing entry is not an exception to that rule but the other side
 * of it: `EntryDetailPage` shows the past moment because it is changing *that
 * entry*, which keeps its own time. A new entry never borrows one.
 */
export function AddEntryPage(): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const ledger = useLedger();
  const quickAmounts = useQuickAmounts();
  const recent = useTransactions({});
  const createEntry = useCreateTransaction();

  /** Set by "复制这一笔" on the detail screen. */
  const copyFrom = (location.state as { copyFrom?: Transaction } | null)?.copyFrom;

  const amountRef = useRef<HTMLInputElement>(null);
  const defaultsApplied = useRef(false);

  const [kind, setKind] = useState<TransactionKind>("expense");
  const [amountText, setAmountText] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [categoryOpen, setCategoryOpen] = useState(false);
  /** Which category's ⓘ explanation is open, if any. */
  const [hintCategoryId, setHintCategoryId] = useState<string | null>(null);
  const [paymentMethodId, setPaymentMethodId] = useState<string | null>(null);
  const [currency, setCurrency] = useState<Currency>("CNY");
  const [occurredAt, setOccurredAt] = useState(() => new Date());
  const [note, setNote] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  /**
   * The entry just saved, or null while the form is showing.
   *
   * Held in component state rather than pushed to a route: the confirmation is
   * the tail of this screen's flow, not a place with its own address. Coming
   * back to /add must never resurrect a filled-in form.
   */
  const [saved, setSaved] = useState<Transaction | null>(null);
  /** Set when the next render should put the cursor back in the amount field. */
  const focusAfterReset = useRef(false);

  const categories = useMemo(
    () =>
      (ledger.data?.categories ?? []).filter(
        // The system category is a fallback, not a choice — never offered.
        (category) => category.kind === kind && !category.isArchived && !category.isSystem,
      ),
    [ledger.data, kind],
  );

  const paymentMethods = useMemo(
    () => (ledger.data?.paymentMethods ?? []).filter((method) => !method.isArchived),
    [ledger.data],
  );

  const tags = ledger.data?.tags ?? [];
  const selectedCategory = categories.find((category) => category.id === categoryId);

  // Defaults are applied exactly once, and only after both reads have settled —
  // otherwise a click made while the data was still loading would be overwritten.
  useEffect(() => {
    if (defaultsApplied.current || copyFrom) return;
    if (!recent.isSuccess || !ledger.isSuccess) return;

    const last = recent.data?.pages[0]?.items[0];
    const fallbackMethod = paymentMethods.find((method) => method.name === DEFAULT_PAYMENT_METHOD_NAME);

    if (last) {
      setCategoryId(last.categoryId);
      setPaymentMethodId(last.paymentMethodId ?? fallbackMethod?.id ?? null);
      setCurrency(last.currency);
    } else {
      setPaymentMethodId(fallbackMethod?.id ?? null);
    }

    defaultsApplied.current = true;
  }, [recent.isSuccess, recent.data, ledger.isSuccess, paymentMethods, copyFrom]);

  // "复制这一笔" pre-fills everything about the source entry except the date,
  // which stays the present: a copy is a new expense, not a re-dating of the old.
  useEffect(() => {
    if (!copyFrom) return;
    setKind(copyFrom.kind);
    setAmountText(minorToInput(copyFrom.amountCents, copyFrom.currency));
    setCategoryId(copyFrom.categoryId);
    setPaymentMethodId(copyFrom.paymentMethodId);
    setCurrency(copyFrom.currency);
    setNote(copyFrom.note ?? "");
    setTagIds(copyFrom.tags.map((tag) => tag.id));
    defaultsApplied.current = true;
  }, [copyFrom]);

  async function save(): Promise<void> {
    setError(null);

    let amountCents: number;
    try {
      amountCents = parseAmountInput(amountText, currency);
    } catch {
      setError(
        decimalsFor(currency) === 0
          ? `${currencyName(currency)}不支持小数，请输入整数金额。`
          : `金额格式不正确，${currencyName(currency)}最多两位小数。`,
      );
      return;
    }

    if (amountCents <= 0) {
      setError("金额需要大于 0。");
      return;
    }

    /**
     * ⚠️ **The time is a *default the user may override*, and that is the whole story.**
     *
     * The owner settled this: **"时间不用是提交的那一刻。因为时间本质上是可以让用户自己编辑的，
     * 预设的时间只是一个方便用户的预设，大多数情况下，记一笔账所花的时间也只有十几秒。所以问题不大。"**
     *
     * So there are two cases, and they must not be confused:
     *
     * | What the user did | What is stored |
     * |---|---|
     * | left the field alone | **now** — a convenience default, and now is what they meant |
     * | **changed the field** | **what they chose**, exactly |
     *
     * ⚠️ **Where this value is read matters, and this is the subtle part.** Reading it *here* — at submit —
     * rather than from the state that was captured when the screen mounted is what makes the default "now".
     * **The screen stays mounted between entries and can sit in the background for hours**, so its mount-time
     * value is not now, and a default that is hours stale is not a convenience. **That staleness is what the
     * owner reported**: two evening entries filed at noon, "被放到了 19:09 和 12 点整的两个账单中间."
     *
     * ⚠️ **An explicitly chosen time is untouched by this**, because `occurredAt` is what the field holds and
     * the field is what the user edited. The edit screen sets it from the entry being edited for the same
     * reason: **a time the user chose outranks any default the program would prefer.**
     */
    const savedAt = new Date();

    try {
      /**
       * ⚠️ **The id and the idempotency key are the same value, minted here.**
       *
       * That is what lets the entry exist — and be shown — before the server has ever heard of it, and it
       * is what makes a replayed upload harmless: the server's `idempotency_key` is unique, so the second
       * delivery finds the row it already made.
       */
      const id = uuidV7();
      const input = {
        id,
        idempotencyKey: id,
        kind,
        amountCents,
        currency,
        categoryId,
        paymentMethodId,
        /**
         * ⚠️ **The default is "now", the user's own choice is kept — see `savedAt` above.**
         */
        occurredAt: toLocalIso(savedAt),
        occurredLocalDate: toLocalDate(savedAt),
        occurredTz: localTimeZone(),
        note: note.trim() === "" ? null : note.trim(),
        tagIds,
      } as const;

      const outcome = await createLocally(
        input,
        localEntry(input, ledger.data),
      );

      /**
       * ⚠️ **A locally stored entry is still a saved entry.**
       *
       * The screen shows its success state either way, because the user's entry *is* recorded — on the
       * device. The only difference is the marker the ledger puts on the row: **silently reporting a write
       * that has not left the device is how somebody loses spending they believe they recorded.**
       */
      setSaved(outcome.entry);
    } catch (caught) {
      /**
       * ⚠️ **Falling back to the local write when the server refuses.**
       *
       * A 5xx or a dropped connection is not a reason to lose what the user typed. The write goes to the
       * device and the queue, and reaches the server when it can — which is the whole point of this round.
       */
      try {
        const id = uuidV7();
        const input = {
          id,
          idempotencyKey: id,
          kind,
          amountCents,
          currency,
          categoryId,
          paymentMethodId,
          occurredAt: toLocalIso(savedAt),
          occurredLocalDate: toLocalDate(savedAt),
          occurredTz: localTimeZone(),
          note: note.trim() === "" ? null : note.trim(),
          tagIds,
        } as const;

        const outcome = await createLocally(input, localEntry(input, ledger.data));

        setSaved(outcome.entry);
      } catch {
        setError(errorMessage(caught));
      }
    }
  }

  // Focus returns to the amount field for the next entry, but only after the
  // form has actually been put back on screen.
  useEffect(() => {
    if (saved === null && focusAfterReset.current) {
      focusAfterReset.current = false;
      amountRef.current?.focus();
    }
  }, [saved]);

  if (saved !== null) {
    return (
      <EntrySaved
        entry={saved}
        categoryName={
          categories.find((category) => category.id === saved.categoryId)?.name ?? UNCATEGORISED_LABEL
        }
        paymentName={
          paymentMethods.find((method) => method.id === saved.paymentMethodId)?.name ?? null
        }
        // The manual form records one entry at a time, so nothing is ever
        // waiting behind it and both ways onward are offered.
        remaining={0}
        onHome={() => {
          void navigate("/");
        }}
        onAgain={() => {
          const next = nextEntryFields(new Date());

          focusAfterReset.current = true;
          setAmountText(next.amountText);
          setNote(next.note);
          setTagIds([...next.tagIds]);
          setOccurredAt(next.occurredAt);
          setError(null);
          setSaved(null);
        }}
      />
    );
  }

  return (
    <TabPage active="/add" onNavigate={(to) => void navigate(to)}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <header className="flex flex-col gap-4 bg-brand px-6 pt-8 pb-6 text-white">
          <div className="flex gap-2">
            {(["expense", "income"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => {
                  setKind(option);
                  setCategoryId(null);
                }}
                className={`flex-1 rounded-field py-2 text-sm font-medium transition ${
                  kind === option ? "bg-white text-brand-dark" : "bg-white/15 text-white/90"
                }`}
              >
                {option === "expense" ? "支出" : "收入"}
              </button>
            ))}
          </div>
        </header>

        {/*
          ⚠️ **The amount is its own card, in white, with a green frame — and the owner asked for exactly
          this**: "现在的手动记账页面金钱的部分底色是绿色的，看起来上面太接近了。我手动记账的时候也出现过
          直接往下滑，没计钱的情况。建议把绿色改为只有支出和收入两个按钮使用绿色。然后把金额的稍微往下移动
          一点，并且周围改为多一个绿色的框，中间还是白底，让人第一时间能把视觉重心放到这里."

          **Two problems, and the second one is about losing money.**

          The green header and the amount field inside it were the same colour family, so the most important
          field on the screen read as part of the chrome. **And he scrolled past it**: with the field flush
          against the buttons, a scroll that was meant to reveal the rest of the form could take the amount
          out of view — and an entry saved with no amount is an entry that has to be found and fixed later.

          **White inside a green frame is the answer to both**: the eye lands on the only white thing above the
          fold, and the frame is a boundary the scroll has to cross rather than a place the cursor can sit
          ambiguously.
        */}
        <section className="bg-canvas px-6 pt-4">
          <label
            className="flex items-baseline gap-2 rounded-card border-2 border-brand bg-surface px-4 py-4 shadow-sm"
          >
            <span className="text-2xl text-brand-dark">{currency === "CNY" ? "¥" : ""}</span>
            <input
              ref={amountRef}
              value={amountText}
              onChange={(event) => {
                setAmountText(event.target.value);
              }}
              inputMode="decimal"
              placeholder={amountPlaceholder(currency)}
              aria-label="金额"
              autoFocus
              className="w-full bg-transparent text-4xl font-semibold text-ink outline-none placeholder:text-muted/80"
            />
            <span className="text-body text-muted">{currency}</span>
          </label>

          <div className="flex flex-wrap gap-2 pt-3">
            {quickAmounts.map((cents) => (
              <button
                key={cents}
                type="button"
                onClick={() => {
                  setAmountText(minorToInput(cents, currency));
                }}
                className="rounded-full border border-brand-soft bg-brand-soft px-3.5 py-1.5 text-body text-brand-dark transition hover:border-brand"
              >
                {minorToInput(cents, currency)}
              </button>
            ))}
          </div>
        </section>

        {/*
          ⚠️ **The rest of the form starts here.** The old markup continued a single header past the amount, so
          everything below was inside the white-on-green block; it now sits on the page background, where
          ordinary fields belong.
        */}
        {error ? (
          <div className="px-6 pt-4">
            <Alert>{error}</Alert>
          </div>
        ) : null}

        <section className="flex flex-col gap-2 px-6 pt-5">
          <h2 className="text-helper text-muted">分类</h2>

          <div className="overflow-hidden rounded-field border border-line bg-surface">
            <button
              type="button"
              aria-expanded={categoryOpen}
              onClick={() => {
                setCategoryOpen((open) => !open);
              }}
              className="flex w-full items-center justify-between px-4 py-3.5 text-left transition hover:bg-canvas"
            >
              <span className="text-button-lg text-ink">
                {selectedCategory?.name ?? UNCATEGORISED_LABEL}
              </span>
              <span className="text-muted" aria-hidden="true">
                {categoryOpen ? "⌃" : "⌄"}
              </span>
            </button>

            {categoryOpen ? (
              <ul className="max-h-64 overflow-y-auto border-t border-line">
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      setCategoryId(null);
                      setCategoryOpen(false);
                    }}
                    className={`w-full px-4 py-3 text-left text-sm transition hover:bg-brand-soft ${
                      categoryId === null ? "text-brand-dark" : "text-ink"
                    }`}
                  >
                    {UNCATEGORISED_LABEL}
                  </button>
                </li>

                {categories.map((category) => (
                  <li key={category.id} className="border-t border-line">
                    <div className="flex items-stretch">
                      <button
                        type="button"
                        onClick={() => {
                          setCategoryId(category.id);
                          setCategoryOpen(false);
                        }}
                        className={`flex-1 px-4 py-3 text-left text-sm transition hover:bg-brand-soft ${
                          category.id === categoryId ? "text-brand-dark" : "text-ink"
                        }`}
                      >
                        {category.name}
                      </button>

                      {/* The explanation belongs to the preset, so it only
                          exists until the category is renamed. */}
                      {category.description ? (
                        <button
                          type="button"
                          aria-label={`${category.name}包含哪些支出`}
                          aria-expanded={hintCategoryId === category.id}
                          onClick={() => {
                            setHintCategoryId((current) =>
                              current === category.id ? null : category.id,
                            );
                          }}
                          className="shrink-0 px-4 text-muted transition hover:text-brand-dark"
                        >
                          <InfoIcon />
                        </button>
                      ) : null}
                    </div>

                    {hintCategoryId === category.id && category.description ? (
                      <p className="px-4 pb-3 text-helper-relaxed text-muted">
                        {category.description}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <p className="text-helper text-muted">不选也可以保存，会记入「{UNCATEGORISED_LABEL}」。</p>
        </section>

        <section className="flex flex-col gap-2 px-6 pt-5">
          <h2 className="text-helper text-muted">支付方式</h2>
          <div className="flex flex-wrap gap-2">
            {paymentMethods.map((method) => (
              <button
                key={method.id}
                type="button"
                onClick={() => {
                  setPaymentMethodId(method.id === paymentMethodId ? null : method.id);
                }}
                className={`rounded-full px-4 py-2 text-sm transition ${
                  method.id === paymentMethodId
                    ? "bg-brand text-white"
                    : "bg-surface text-ink hover:bg-brand-soft"
                }`}
              >
                {method.name}
              </button>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-2 px-6 pt-5">
          <h2 className="text-helper text-muted">币种</h2>
          <div className="flex flex-wrap gap-2">
            {CURRENCIES.map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => {
                  setCurrency(code);
                }}
                className={`rounded-full px-4 py-2 text-sm transition ${
                  code === currency ? "bg-brand text-white" : "bg-surface text-ink hover:bg-brand-soft"
                }`}
              >
                {currencyName(code)}
              </button>
            ))}
          </div>
          <p className="text-helper-relaxed text-muted">
            金额按各币种自身的精度记录，例如日元不保留小数。
          </p>
        </section>

        <section className="flex flex-col gap-2 px-6 pt-5">
          <h2 className="text-helper text-muted">时间</h2>
          <input
            type="datetime-local"
            step="1"
            value={toDateTimeLocalValue(occurredAt)}
            onChange={(event) => {
              const parsed = fromDateTimeLocalValue(event.target.value);
              if (parsed) setOccurredAt(parsed);
            }}
            className="rounded-field border border-line bg-surface px-3.5 py-3 text-base text-ink outline-none focus:border-brand focus:ring-4 focus:ring-brand-soft"
          />
        </section>

        <section className="flex flex-col gap-2 px-6 pt-5">
          <h2 className="text-helper text-muted">备注</h2>
          <input
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
            maxLength={200}
            placeholder="可不填"
            className="rounded-field border border-line bg-surface px-3.5 py-3 text-base text-ink outline-none placeholder:text-muted/80 focus:border-brand focus:ring-4 focus:ring-brand-soft"
          />
        </section>

        {tags.length > 0 ? (
          <section className="flex flex-col gap-2 px-6 pt-5">
            <h2 className="text-helper text-muted">
              标签（最多 {String(MAX_TAGS_PER_TRANSACTION)} 个，已选 {String(tagIds.length)} 个）
            </h2>
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => {
                const selected = tagIds.includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => {
                      setTagIds((current) =>
                        current.includes(tag.id)
                          ? current.filter((id) => id !== tag.id)
                          : current.length >= MAX_TAGS_PER_TRANSACTION
                            ? current
                            : [...current, tag.id],
                      );
                    }}
                    style={selected ? { backgroundColor: tag.color, borderColor: tag.color } : undefined}
                    className={`rounded-full border px-3.5 py-1.5 text-sm transition ${
                      selected ? "text-white" : "border-line bg-surface text-ink hover:bg-brand-soft"
                    }`}
                  >
                    {tag.name}
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}

        <div className="flex flex-col gap-3 px-6 py-6">
          <button
            type="submit"
            disabled={createEntry.isPending || amountText.trim() === ""}
            className="w-full rounded-field bg-brand py-3.5 text-button-lg font-medium text-white transition hover:bg-brand-dark disabled:opacity-45"
          >
            {createEntry.isPending ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </TabPage>
  );
}

/** The form fields a new entry starts from, once its moment is known. */
export interface NextEntryFields {
  readonly amountText: string;
  readonly note: string;
  readonly tagIds: readonly string[];
  readonly occurredAt: Date;
}

/**
 * What "再记一笔" puts the form back into.
 *
 * The date is part of the reset, like the amount and the note: it is the moment
 * the button was pressed, never the moment of the entry just saved. `now` is an
 * argument rather than a call to the clock inside, so this rule can be asserted
 * in a test without a browser — the same reason `draftOf` in the scan screen is
 * a free function.
 */
export function nextEntryFields(now: Date): NextEntryFields {
  return { amountText: "", note: "", tagIds: [], occurredAt: now };
}
