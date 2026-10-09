import {
  CURRENCIES,
  MAX_TAGS_PER_TRANSACTION,
  parseAmountToCents,
  type Currency,
  type Transaction,
  type TransactionKind,
} from "@libellum/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";

import { Alert } from "../components/Alert.js";
import { TabPage } from "../components/Layouts.js";
import { errorMessage } from "../lib/api.js";
import {
  fromDateTimeLocalValue,
  localTimeZone,
  toDateTimeLocalValue,
  toLocalDate,
  toLocalIso,
} from "../lib/datetime.js";
import { centsToInput, currencyName } from "../lib/format.js";
import { useCreateTransaction, useLedger, useQuickAmounts, useTransactions } from "../lib/queries.js";
import { uuidV7 } from "../lib/uuid.js";

/**
 * The screen the whole application exists for.
 *
 * Everything it needs to open populated comes from two reads: the ledger meta
 * (categories, payment methods, tags) and the newest entries, used both for
 * the "same as last time" defaults and for the quick-amount shortcuts.
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

  const [kind, setKind] = useState<TransactionKind>("expense");
  const [amountText, setAmountText] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [paymentMethodId, setPaymentMethodId] = useState<string | null>(null);
  const [currency, setCurrency] = useState<Currency>("CNY");
  const [occurredAt, setOccurredAt] = useState(() => new Date());
  const [note, setNote] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  /** Set by "再记一笔" so the next entry keeps the date just used. */
  const [isContinuous, setContinuous] = useState(false);

  const lastEntry: Transaction | undefined = recent.data?.pages[0]?.items[0];

  // Defaults follow the previous entry — category, payment method and currency.
  // The *date* deliberately does not: the previous entry may be from days ago,
  // and silently recording today's spending under an old date is worse than
  // losing one tap. Continuous entry (再记一笔) does keep the date, because
  // there the user really is filling in one day's receipts.
  useEffect(() => {
    if (!lastEntry || isContinuous || copyFrom) return;
    setCategoryId(lastEntry.categoryId);
    setPaymentMethodId(lastEntry.paymentMethodId);
    setCurrency(lastEntry.currency);
  }, [lastEntry, isContinuous, copyFrom]);

  // "复制这一笔" pre-fills everything about the source entry except the date,
  // which stays today: a copy is a new expense, not a re-dating of the old one.
  useEffect(() => {
    if (!copyFrom) return;
    setKind(copyFrom.kind);
    setAmountText(centsToInput(copyFrom.amountCents));
    setCategoryId(copyFrom.categoryId);
    setPaymentMethodId(copyFrom.paymentMethodId);
    setCurrency(copyFrom.currency);
    setNote(copyFrom.note ?? "");
    setTagIds(copyFrom.tags.map((tag) => tag.id));
  }, [copyFrom]);

  useEffect(() => {
    if (isContinuous) {
      setOccurredAt(new Date());
      setContinuous(false);
    }
  }, [isContinuous]);

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

  function reset(keepDefaults: boolean): void {
    setAmountText("");
    setNote("");
    setTagIds([]);
    setError(null);
    if (!keepDefaults) {
      setCategoryId(null);
      setPaymentMethodId(null);
    }
    amountRef.current?.focus();
  }

  async function save(): Promise<void> {
    setError(null);

    let amountCents: number;
    try {
      amountCents = parseAmountToCents(amountText);
    } catch {
      setError("请输入有效的金额，最多两位小数。");
      return;
    }

    if (amountCents <= 0) {
      setError("金额需要大于 0。");
      return;
    }

    try {
      await createEntry.mutateAsync({
        id: uuidV7(),
        idempotencyKey: uuidV7(),
        kind,
        amountCents,
        currency,
        categoryId,
        paymentMethodId,
        occurredAt: toLocalIso(occurredAt),
        occurredLocalDate: toLocalDate(occurredAt),
        occurredTz: localTimeZone(),
        note: note.trim() === "" ? null : note.trim(),
        tagIds,
      });

      setSavedCount((count) => count + 1);
      // Stay on the screen so a stack of receipts can be entered in a row.
      setContinuous(true);
      reset(true);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <TabPage active="/add" onNavigate={(to) => void navigate(to)}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
      <header className="flex flex-col gap-5 bg-brand px-5 pt-8 pb-6 text-white">
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

        <label className="flex items-baseline gap-2 border-b border-white/30 pb-2">
          <span className="text-2xl">{currency === "CNY" ? "¥" : ""}</span>
          <input
            ref={amountRef}
            value={amountText}
            onChange={(event) => {
              setAmountText(event.target.value);
            }}
            inputMode="decimal"
            placeholder="0.00"
            aria-label="金额"
            autoFocus
            className="w-full bg-transparent text-4xl font-semibold text-white outline-none placeholder:text-white/40"
          />
          <span className="text-sm text-white/70">{currency}</span>
        </label>

        <div className="flex flex-wrap gap-2">
          {quickAmounts.map((cents) => (
            <button
              key={cents}
              type="button"
              onClick={() => {
                setAmountText(centsToInput(cents));
              }}
              className="rounded-full bg-white/15 px-3.5 py-1.5 text-sm text-white transition hover:bg-white/25"
            >
              {centsToInput(cents)}
            </button>
          ))}
        </div>
      </header>

      {savedCount > 0 ? (
        <div className="px-5 pt-4">
          <Alert tone="success">
            已记录 {String(savedCount)} 笔，可以接着记下一笔。
          </Alert>
        </div>
      ) : null}

      {error ? (
        <div className="px-5 pt-4">
          <Alert>{error}</Alert>
        </div>
      ) : null}

      <section className="flex flex-col gap-2 px-5 pt-5">
        <h2 className="text-xs text-muted">分类</h2>
        <div className="grid grid-cols-3 gap-2">
          {categories.map((category) => (
            <button
              key={category.id}
              type="button"
              onClick={() => {
                setCategoryId(category.id === categoryId ? null : category.id);
              }}
              className={`rounded-field py-3 text-sm transition ${
                category.id === categoryId
                  ? "bg-brand text-white"
                  : "bg-surface text-ink hover:bg-brand-soft"
              }`}
            >
              {category.name}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted">不选也可以保存，会记入「暂无分类」。</p>
      </section>

      <section className="flex flex-col gap-2 px-5 pt-5">
        <h2 className="text-xs text-muted">支付方式</h2>
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

      <section className="flex flex-col gap-2 px-5 pt-5">
        <h2 className="text-xs text-muted">币种</h2>
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
        <p className="text-xs leading-relaxed text-muted">
          所有币种均按两位小数记录；不同币种分开统计，不进行汇率换算。
        </p>
      </section>

      <section className="flex flex-col gap-2 px-5 pt-5">
        <h2 className="text-xs text-muted">时间</h2>
        <input
          type="datetime-local"
          step="1"
          value={toDateTimeLocalValue(occurredAt)}
          onChange={(event) => {
            const parsed = fromDateTimeLocalValue(event.target.value);
            if (parsed) setOccurredAt(parsed);
          }}
          className="rounded-field border border-line bg-surface px-3.5 py-3 text-[15px] text-ink outline-none focus:border-brand focus:ring-4 focus:ring-brand-soft"
        />
      </section>

      <section className="flex flex-col gap-2 px-5 pt-5">
        <h2 className="text-xs text-muted">备注</h2>
        <input
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
          maxLength={200}
          placeholder="可不填"
          className="rounded-field border border-line bg-surface px-3.5 py-3 text-[15px] text-ink outline-none placeholder:text-muted/60 focus:border-brand focus:ring-4 focus:ring-brand-soft"
        />
      </section>

      {tags.length > 0 ? (
        <section className="flex flex-col gap-2 px-5 pt-5">
          <h2 className="text-xs text-muted">
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

      <div className="flex flex-col gap-3 px-5 py-6">
        <button
          type="submit"
          disabled={createEntry.isPending || amountText.trim() === ""}
          className="w-full rounded-field bg-brand py-3.5 text-[15px] font-medium text-white transition hover:bg-brand-dark disabled:opacity-50"
        >
          {createEntry.isPending ? "保存中…" : "保存"}
        </button>

        {savedCount > 0 ? (
          <button
            type="button"
            onClick={() => void navigate("/")}
            className="w-full rounded-field bg-surface py-3 text-sm text-muted transition hover:text-ink"
          >
            完成，回到明细
          </button>
        ) : null}
      </div>
      </form>
    </TabPage>
  );
}
