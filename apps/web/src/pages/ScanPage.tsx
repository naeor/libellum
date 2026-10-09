import {
  CURRENCIES,
  MAX_RECOGNIZE_IMAGES,
  decimalsFor,
  formatMinor,
  type Currency,
  type OcrItemResult,
  type Transaction,
  type TransactionKind,
} from "@libellum/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { Alert } from "../components/Alert.js";
import { Button } from "../components/Button.js";
import { CameraIcon } from "../components/BottomNav.js";
import { EntrySaved } from "../components/EntrySaved.js";
import { InnerPage } from "../components/Layouts.js";
import { SkeletonRows } from "../components/States.js";
import { errorMessage } from "../lib/api.js";
import { currentMonth, localTimeZone, toLocalDate, toLocalIso } from "../lib/datetime.js";
import { amountPlaceholder, currencyName, parseAmountInput } from "../lib/format.js";
import { useCreateTransaction, useLedger, useRecognize, useTransactions } from "../lib/queries.js";

/**
 * Recording from a screenshot.
 *
 * Four steps, and the screen never shows more than one of them: choose,
 * recognise, check, saved. The check step is the point of the whole feature —
 * the recogniser produces a *guess*, and a guess is only useful if somebody
 * looks at it before it becomes a fact. Every field is editable and a field
 * that could not be read is left empty with a reason, never defaulted to
 * something plausible. A wrong amount gets confirmed; a blank one gets filled
 * in.
 */
type Step =
  | { readonly name: "pick" }
  | { readonly name: "working"; readonly index: number; readonly total: number }
  | { readonly name: "review"; readonly draft: ReviewDraft; readonly warnings: readonly string[] }
  | { readonly name: "saved"; readonly entry: Transaction };

/** A recognition result, in the shape the form edits. */
interface ReviewDraft {
  amount: string;
  kind: TransactionKind;
  currency: Currency;
  date: string;
  time: string;
  categoryId: string | null;
  paymentMethodId: string | null;
  note: string;
}

type Mode = "single" | "batch";

export function ScanPage(): React.JSX.Element {
  const navigate = useNavigate();
  const ledger = useLedger();
  const recognize = useRecognize();
  const createEntry = useCreateTransaction();

  const [files, setFiles] = useState<File[]>([]);
  const [mode, setMode] = useState<Mode>("single");
  const [step, setStep] = useState<Step>({ name: "pick" });
  const [error, setError] = useState<string | null>(null);

  /** Results that could be read, and where we are among them. */
  const [items, setItems] = useState<OcrItemResult[]>([]);
  const [cursor, setCursor] = useState(0);

  const categories = ledger.data?.categories ?? [];
  const paymentMethods = ledger.data?.paymentMethods ?? [];

  /**
   * The category a new entry starts on: whatever was used last, which is a far
   * better guess than the system "uncategorised" bucket that everything else
   * would land in. Screenshots never carry a category — no payment app knows
   * how you file your spending.
   */
  const recent = useTransactions({ month: currentMonth(), kind: "expense" });
  const lastCategoryId = recent.data?.pages[0]?.items[0]?.categoryId ?? null;

  // Object URLs for the thumbnails; released when the files change or the
  // screen unmounts, or the browser holds every image for the tab's lifetime.
  const previews = useMemo(() => files.map((file) => URL.createObjectURL(file)), [files]);

  useEffect(
    () => () => {
      for (const url of previews) URL.revokeObjectURL(url);
    },
    [previews],
  );

  function addFiles(incoming: FileList | null): void {
    if (incoming === null) return;

    const chosen = [...incoming];
    const combined = [...files, ...chosen];

    if (combined.length > MAX_RECOGNIZE_IMAGES) {
      setError(`一次最多 ${String(MAX_RECOGNIZE_IMAGES)} 张截图。`);
      setFiles(combined.slice(0, MAX_RECOGNIZE_IMAGES));
      return;
    }

    setError(null);
    setFiles(combined);
  }

  async function start(): Promise<void> {
    if (files.length === 0) return;

    setError(null);
    setStep({ name: "working", index: 1, total: files.length });

    try {
      const result = await recognize.mutateAsync(files);

      // A screenshot nobody could read is dropped here, with a count, rather
      // than being carried into the review queue as an empty form the user has
      // to work out is empty.
      const readable = result.items.filter((item) => item.ok && item.draft !== null);
      const lost = result.items.length - readable.length;

      if (readable.length === 0) {
        setError("这几张都没能识别出来。可以换一张更清晰的截图，或者直接手动记账。");
        setStep({ name: "pick" });
        return;
      }

      if (lost > 0) {
        setError(`有 ${String(lost)} 张没能识别出来，已跳过。`);
      }

      setItems(readable);
      setCursor(0);
      setStep({
        name: "review",
        draft:
          mode === "single"
            ? foldDrafts(readable, categories, paymentMethods, lastCategoryId)
            : draftOf(readable[0]!, categories, paymentMethods, lastCategoryId),
        warnings: readable[0]?.draft?.warnings ?? [],
      });
    } catch (caught) {
      setError(errorMessage(caught));
      setStep({ name: "pick" });
    }
  }

  /** Move to the next screenshot in a batch, or finish. */
  function advance(next: number): void {
    const item = items[next];

    if (item === undefined) {
      void navigate("/");
      return;
    }

    setCursor(next);
    setStep({
      name: "review",
      draft: draftOf(item, categories, paymentMethods, lastCategoryId),
      warnings: [...(item.draft?.warnings ?? [])],
    });
  }

  /** How many are still waiting, including the one on screen. */
  const remaining = mode === "single" ? 1 : items.length - cursor;

  async function save(draft: ReviewDraft): Promise<void> {
    setError(null);

    let amountCents: number;
    try {
      amountCents = parseAmountInput(draft.amount, draft.currency);
    } catch {
      setError(
        decimalsFor(draft.currency) === 0
          ? `${currencyName(draft.currency)}不支持小数，请输入整数金额。`
          : "金额格式不正确。",
      );
      return;
    }

    if (amountCents <= 0) {
      setError("金额需要大于 0。");
      return;
    }

    const occurredAt = new Date(`${draft.date}T${draft.time === "" ? "12:00" : draft.time}:00`);

    try {
      const entry = await createEntry.mutateAsync({
        id: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        kind: draft.kind,
        amountCents,
        currency: draft.currency,
        categoryId: draft.categoryId,
        paymentMethodId: draft.paymentMethodId,
        occurredAt: toLocalIso(occurredAt),
        occurredLocalDate: toLocalDate(occurredAt),
        occurredTz: localTimeZone(),
        note: draft.note.trim() === "" ? null : draft.note.trim(),
        tagIds: [],
      });

      setStep({ name: "saved", entry });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <InnerPage
      title="拍照记账"
      subtitle="上传付款截图，识别后由你核对。截图不会被保存，识别完成即丢弃。"
      backTo="/"
    >
      {error === null ? null : <Alert tone="error">{error}</Alert>}

      {step.name === "pick" ? (
        <PickStep
          files={files}
          previews={previews}
          mode={mode}
          busy={false}
          onAdd={addFiles}
          onRemove={(index) => {
            setFiles((current) => current.filter((_, position) => position !== index));
          }}
          onMode={setMode}
          onStart={() => void start()}
          onManual={() => void navigate("/add")}
        />
      ) : null}

      {step.name === "working" ? <WorkingStep total={step.total} /> : null}

      {step.name === "review" ? (
        <ReviewStep
          draft={step.draft}
          warnings={step.warnings}
          remaining={remaining}
          categories={categories}
          paymentMethods={paymentMethods}
          busy={createEntry.isPending}
          onSave={(draft) => void save(draft)}
          onManual={() => void navigate("/add")}
        />
      ) : null}

      {step.name === "saved" ? (
        <div className="flex flex-col gap-4">
          {mode === "batch" && cursor + 1 < items.length ? (
            <Alert tone="success">
              已保存。还有 {items.length - cursor - 1} 张需要核对。
            </Alert>
          ) : null}

          <EntrySaved
            entry={step.entry}
            categoryName={
              categories.find((category) => category.id === step.entry.categoryId)?.name ?? "暂无分类"
            }
            paymentName={
              paymentMethods.find((method) => method.id === step.entry.paymentMethodId)?.name ?? null
            }
            onHome={() => void navigate("/")}
            onAgain={() => {
              // In a batch, "one more" means the next screenshot in it; in the
              // single mode there is nothing left, so it starts over.
              if (mode === "batch" && cursor + 1 < items.length) {
                advance(cursor + 1);
                return;
              }

              setFiles([]);
              setItems([]);
              setCursor(0);
              setStep({ name: "pick" });
            }}
          />
        </div>
      ) : null}
    </InnerPage>
  );
}

function PickStep({
  files,
  previews,
  mode,
  busy,
  onAdd,
  onRemove,
  onMode,
  onStart,
  onManual,
}: {
  readonly files: readonly File[];
  readonly previews: readonly string[];
  readonly mode: Mode;
  readonly busy: boolean;
  readonly onAdd: (files: FileList | null) => void;
  readonly onRemove: (index: number) => void;
  readonly onMode: (mode: Mode) => void;
  readonly onStart: () => void;
  readonly onManual: () => void;
}): React.JSX.Element {
  const pickerRef = useRef<HTMLInputElement>(null);
  const [pickerAsked, setPickerAsked] = useState(false);
  const [pickerSilent, setPickerSilent] = useState(false);

  return (
    <div className="flex flex-col gap-5">
      {/*
        `sr-only`, not `hidden`. `display: none` is what the first two attempts
        used, and iOS Safari is documented to ignore a programmatic click on a
        file input that is not rendered at all. Clipping it off-screen keeps it
        in the layout, which is the version that works everywhere.

        No `capture` attribute: that is what lets the browser offer camera and
        photo library in the same sheet, which is the choice the user needs.
        Forcing `capture` would remove the library entirely.
      */}
      <input
        ref={pickerRef}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        onChange={(event) => {
          setPickerAsked(false);
          setPickerSilent(false);
          onAdd(event.target.files);
          // Reset so choosing the same file twice still fires a change.
          event.target.value = "";
        }}
      />

      <button
        type="button"
        onClick={() => {
          // A picker that never opens and a tap that never registered look
          // identical from the outside. Saying what happened is the difference
          // between "broken" and "I must have missed".
          setPickerAsked(true);
          setPickerSilent(false);
          pickerRef.current?.click();
          window.setTimeout(() => {
            setPickerSilent(true);
          }, 3000);
        }}
        className="flex flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed border-line bg-surface py-10 text-center transition hover:border-brand active:bg-canvas"
      >
        <CameraIcon />
        <span className="text-sm text-ink">选择截图</span>
        <span className="text-xs text-muted">
          微信 / 支付宝 / 银行的付款截图，最多 {MAX_RECOGNIZE_IMAGES} 张
        </span>
      </button>

      {pickerAsked && pickerSilent ? (
        <Alert tone="info">
          没有收到图片。如果选择器一直打不开，可以先用
          <button type="button" className="mx-1 underline" onClick={onManual}>
            手动记账
          </button>
          ，功能不受影响。
        </Alert>
      ) : null}

      {files.length === 0 ? null : (
        <ul className="flex flex-wrap gap-3">
          {previews.map((url, index) => (
            <li key={url} className="relative">
              <img src={url} alt={`第 ${String(index + 1)} 张截图`} className="size-20 rounded-field object-cover" />
              <button
                type="button"
                aria-label={`移除第 ${String(index + 1)} 张`}
                onClick={() => {
                  onRemove(index);
                }}
                className="absolute -top-1.5 -right-1.5 flex size-6 items-center justify-center rounded-full bg-ink/75 text-xs text-white"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-xs text-muted">这些截图怎么算</h2>
        <div className="flex flex-col gap-2">
          <ModeOption
            mode="single"
            current={mode}
            title="同一笔消费，分几张凭证"
            hint="金额相加，只核对一次"
            onSelect={onMode}
          />
          <ModeOption
            mode="batch"
            current={mode}
            title="几笔不同的消费"
            hint="每张单独核对一次"
            onSelect={onMode}
          />
        </div>
      </section>

      <Button disabled={files.length === 0 || busy} onClick={onStart}>
        开始识别
      </Button>

      <button type="button" onClick={onManual} className="text-xs text-muted underline">
        识别不方便？直接手动记账
      </button>

      {busy ? <SkeletonRows rows={2} /> : null}
    </div>
  );
}

function ModeOption({
  mode,
  current,
  title,
  hint,
  onSelect,
}: {
  readonly mode: Mode;
  readonly current: Mode;
  readonly title: string;
  readonly hint: string;
  readonly onSelect: (mode: Mode) => void;
}): React.JSX.Element {
  const selected = mode === current;

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => {
        onSelect(mode);
      }}
      className={`flex flex-col gap-0.5 rounded-field border px-4 py-3 text-left transition ${
        selected ? "border-brand bg-brand-soft" : "border-line bg-surface"
      }`}
    >
      <span className="text-sm text-ink">{title}</span>
      <span className="text-xs text-muted">{hint}</span>
    </button>
  );
}

function WorkingStep({ total }: { readonly total: number }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-4 py-10">
      <div className="size-10 animate-spin rounded-full border-3 border-brand-soft border-t-brand" />
      <p className="text-sm text-ink">正在识别…</p>
      <p className="text-xs text-muted">
        共 {total} 张，每张约需 1.5 秒。截图识别完成后即被丢弃。
      </p>
    </div>
  );
}

function ReviewStep({
  draft,
  warnings,
  remaining,
  categories,
  paymentMethods,
  busy,
  onSave,
  onManual,
}: {
  readonly draft: ReviewDraft;
  readonly warnings: readonly string[];
  readonly remaining: number;
  readonly categories: readonly { id: string; name: string; kind: string; isArchived: boolean }[];
  readonly paymentMethods: readonly { id: string; name: string; isArchived: boolean }[];
  readonly busy: boolean;
  readonly onSave: (draft: ReviewDraft) => void;
  readonly onManual: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState<ReviewDraft>(draft);

  const usableCategories = categories.filter(
    (category) => category.kind === value.kind && !category.isArchived,
  );
  const usableMethods = paymentMethods.filter((method) => !method.isArchived);

  const patch = (changes: Partial<ReviewDraft>): void => {
    setValue((current) => ({ ...current, ...changes }));
  };

  return (
    <div className="flex flex-col gap-5">
      {warnings.length === 0 ? null : (
        <Alert tone="info">
          <ul className="flex flex-col gap-1">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Alert>
      )}

      {remaining > 1 ? (
        <p className="text-xs text-muted">还有 {remaining} 张需要核对</p>
      ) : null}

      {/* The amount is the thing being checked, so it is the largest control
          on the screen and the first thing the eye lands on. */}
      <section className="flex flex-col gap-2">
        <label htmlFor="scan-amount" className="text-xs text-muted">
          金额
        </label>
        <div className="flex items-baseline gap-2 rounded-card border border-line bg-surface px-5 py-4">
          <span className="text-xl text-muted">¥</span>
          <input
            id="scan-amount"
            value={value.amount}
            onChange={(event) => {
              patch({ amount: event.target.value });
            }}
            inputMode="decimal"
            placeholder={amountPlaceholder(value.currency)}
            className="w-full bg-transparent text-3xl font-semibold tabular-nums text-ink outline-none"
          />
        </div>
      </section>

      <section className="flex gap-2">
        {(["expense", "income"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={value.kind === option}
            onClick={() => {
              patch({ kind: option });
            }}
            className={`flex-1 rounded-field py-2.5 text-sm font-medium transition ${
              value.kind === option ? "bg-brand text-white" : "bg-surface text-muted"
            }`}
          >
            {option === "expense" ? "支出" : "收入"}
          </button>
        ))}
      </section>

      <section className="flex gap-3">
        <Field label="日期">
          <input
            type="date"
            value={value.date}
            onChange={(event) => {
              patch({ date: event.target.value });
            }}
            className="w-full rounded-field border border-line bg-surface px-3 py-2.5 text-base text-ink outline-none focus:border-brand"
          />
        </Field>
        <Field label="时间">
          <input
            type="time"
            value={value.time}
            onChange={(event) => {
              patch({ time: event.target.value });
            }}
            className="w-full rounded-field border border-line bg-surface px-3 py-2.5 text-base text-ink outline-none focus:border-brand"
          />
        </Field>
      </section>

      <Field label="分类">
        <select
          value={value.categoryId ?? ""}
          onChange={(event) => {
            patch({ categoryId: event.target.value === "" ? null : event.target.value });
          }}
          className="w-full rounded-field border border-line bg-surface px-3 py-2.5 text-base text-ink outline-none focus:border-brand"
        >
          <option value="">暂无分类</option>
          {usableCategories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="支付方式">
        <select
          value={value.paymentMethodId ?? ""}
          onChange={(event) => {
            patch({ paymentMethodId: event.target.value === "" ? null : event.target.value });
          }}
          className="w-full rounded-field border border-line bg-surface px-3 py-2.5 text-base text-ink outline-none focus:border-brand"
        >
          <option value="">未选择</option>
          {usableMethods.map((method) => (
            <option key={method.id} value={method.id}>
              {method.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="备注">
        <input
          value={value.note}
          maxLength={200}
          placeholder="可不填"
          onChange={(event) => {
            patch({ note: event.target.value });
          }}
          className="w-full rounded-field border border-line bg-surface px-3 py-2.5 text-base text-ink outline-none placeholder:text-muted/60 focus:border-brand"
        />
      </Field>

      <Button
        disabled={busy}
        onClick={() => {
          onSave(value);
        }}
      >
        {busy ? "保存中…" : "确认并保存"}
      </Button>

      <button type="button" onClick={onManual} className="text-xs text-muted underline">
        识别得不对？改成手动记账
      </button>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="flex flex-1 flex-col gap-1.5">
      <span className="text-xs text-muted">{label}</span>
      {children}
    </label>
  );
}

/** Build the form's starting values from one recognition result. */
export function draftOf(
  item: OcrItemResult,
  categories: readonly { id: string; name: string; kind: string; isArchived: boolean }[],
  paymentMethods: readonly { id: string; name: string; isArchived: boolean; channel?: string }[],
  lastCategoryId: string | null,
): ReviewDraft {
  const draft = item.draft;
  const now = new Date();

  const kind: TransactionKind = draft?.kind === "income" ? "income" : "expense";

  // The channel narrows the payment method: a WeChat screenshot means WeChat.
  // Nothing is invented when there is no match — an empty field is honest.
  const channelNames: Record<string, string> = { WECHAT: "微信", ALIPAY: "支付宝", BANK: "银行卡" };
  const wanted = draft?.channel === null || draft?.channel === undefined ? null : channelNames[draft.channel];
  const method = wanted === null ? undefined : paymentMethods.find((entry) => entry.name === wanted);

  const date = draft?.occurredLocalDate ?? toLocalDate(now);
  const time = draft?.occurredTime ?? "";

  return {
    amount: draft?.amount ?? "",
    kind,
    currency: (CURRENCIES as readonly string[]).includes(draft?.currency ?? "")
      ? (draft?.currency as Currency)
      : "CNY",
    date,
    time,
    // Only a category the form will actually offer. Accepting an archived one
    // would leave the select showing 暂无分类 while the state still held the
    // archived id, and the entry would be filed under a category the user
    // could not see was selected.
    categoryId: categories.some(
      (category) => category.id === lastCategoryId && !category.isArchived,
    )
      ? lastCategoryId
      : null,
    paymentMethodId: method?.id ?? null,
    note: [draft?.counterparty, draft?.note].filter((part) => part !== null && part !== "").join(" · "),
  };
}

/** The single-entry mode: several proofs, one purchase, so the amounts add up. */
export function foldDrafts(
  items: readonly OcrItemResult[],
  categories: readonly { id: string; name: string; kind: string; isArchived: boolean }[],
  paymentMethods: readonly { id: string; name: string; isArchived: boolean; channel?: string }[],
  lastCategoryId: string | null,
): ReviewDraft {
  const first = items[0];
  const base =
    first === undefined
      ? null
      : draftOf(first, categories, paymentMethods, lastCategoryId);

  const fallback: ReviewDraft = base ?? {
    amount: "",
    kind: "expense",
    currency: "CNY",
    date: toLocalDate(new Date()),
    time: "",
    categoryId: null,
    paymentMethodId: null,
    note: "",
  };

  const currencies = new Set(items.map((item) => item.draft?.currency ?? "CNY"));
  if (currencies.size > 1) {
    // Adding yuan to yen is meaningless, so it is refused rather than guessed.
    return { ...fallback, amount: "" };
  }

  let total = 0;
  let readable = 0;

  for (const item of items) {
    const amount = item.draft?.amount;
    if (amount === null || amount === undefined || amount === "") continue;

    try {
      total += parseAmountInput(amount, fallback.currency);
      readable += 1;
    } catch {
      // An unreadable amount is skipped; the total is of what could be read.
    }
  }

  if (readable === 0) return fallback;

  return {
    ...fallback,
    // Formatted through the currency's own precision, not by dividing: 30.30
    // must not come back as 30.3, or the field would disagree with every other
    // amount on the screen.
    amount: formatMinor(total, decimalsFor(fallback.currency)),
  };
}
