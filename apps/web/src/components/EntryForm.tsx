import { type Currency, type TransactionKind } from "@libellum/shared";
import { useState } from "react";

import { amountPlaceholder } from "../lib/format.js";

import { Alert } from "./Alert.js";
import { Button } from "./Button.js";

/**
 * The form that confirms an entry before it is saved.
 *
 * **Shared by both ways of recording.** Photographing a receipt and speaking a
 * sentence produce different starting values and exactly the same questions: how
 * much, what kind, when, under what category, paid how, and what to write in the
 * note. The owner asked for the voice screen's review to be like the camera's —
 * "跟拍照记账的核对页面可以类似" — and *like* is best served by the same component:
 * two copies would drift the first time a field was added to one of them.
 *
 * What differs is only the draft it starts from and what "save" does with it.
 */

/** A recognition result, in the shape the form edits. */
export interface ReviewDraft {
  amount: string;
  kind: TransactionKind;
  currency: Currency;
  date: string;
  time: string;
  categoryId: string | null;
  paymentMethodId: string | null;
  note: string;
}

export function ReviewStep({
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
  readonly categories: readonly { id: string; name: string; kind: string; isArchived: boolean; isSystem: boolean }[];
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

      {/*
        Date and time, side by side, with the time field's left edge **on the
        screen's centre line**.

        **Fixed widths, not `flex-1`.** The owner reported these two overlapping
        on his phone, with the time field pushed off the right edge, and the cause
        is that `input[type=date]` and `input[type=time]` carry a wide intrinsic
        minimum width in Safari — wider than `flex-1`'s share of a phone screen.
        Without `min-w-0`, a flex item refuses to shrink below that width, so the
        pair overflowed and the boxes ran into each other.

        ⚠️ **Then he reported the overlap again, and the leftover cause was this:**
        the row was `w-3/5` of the screen with a 3:2 split inside it, so the date
        field's right edge sat at 36% of the screen and the gap after it ran from
        36% to 42%. The time field started at 42% — **close to the centre line but
        not on it**, and the date box's own border sat only a gap away, which is
        what "那个框总是会和时间重合" describes.

        So the split is no longer a proportion of a narrower row. `basis-1/2` puts
        the date's right edge at **exactly 50%**, the time field's left edge at
        **exactly 50% + gap** — the centre line — and `shrink-0` on both stops
        Safari's intrinsic minimum from moving either one.

        `min-w-0` stays because it is what allows the intrinsic minimum to be
        ignored at all; without it the fixed basis is advisory.
      */}
      <section className="flex gap-3">
        <Field label="日期" className="basis-1/2 min-w-0 shrink-0">
          <input
            type="date"
            value={value.date}
            onChange={(event) => {
              patch({ date: event.target.value });
            }}
            className="w-full min-w-0 rounded-field border border-line bg-surface px-3 py-2.5 text-base text-ink outline-none focus:border-brand"
          />
        </Field>
        <Field label="时间" className="basis-1/2 min-w-0 shrink-0">
          <input
            type="time"
            value={value.time}
            onChange={(event) => {
              patch({ time: event.target.value });
            }}
            className="w-full min-w-0 rounded-field border border-line bg-surface px-3 py-2.5 text-base text-ink outline-none focus:border-brand"
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

/**
 * A labelled form control.
 *
 * `min-w-0` is not decoration: this is a flex item, and without it the item
 * refuses to shrink below its content's intrinsic minimum width. Safari gives
 * `input[type=date]` and `input[type=time]` a wide minimum, which is how the
 * date and time fields came to overlap on a phone. The caller passes a `basis`
 * when the two fields beside each other should keep fixed proportions.
 */
function Field({
  label,
  children,
  className = "flex-1",
}: {
  readonly label: string;
  readonly children: React.ReactNode;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <label className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <span className="text-xs text-muted">{label}</span>
      {children}
    </label>
  );
}

/** Build the form's starting values from one recognition result. */

