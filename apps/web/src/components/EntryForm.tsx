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
        <p className="text-helper text-muted">还有 {remaining} 张需要核对</p>
      ) : null}

      {/* The amount is the thing being checked, so it is the largest control
          on the screen and the first thing the eye lands on. */}
      <section className="flex flex-col gap-2">
        <label htmlFor="scan-amount" className="text-helper text-muted">
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
        Date and time, **one per row**.

        ⚠️ **This is the fourth attempt, and the first three failed for three
        different reasons — worth recording, because the sequence is instructive.**

        1. Row `w-3/5` split 3:2 → the time field sat at 42%: "偏左一个字".
        2. Both halves `basis-1/2` across the full screen → the second column began
           at 50% *plus half the gap*: "往右偏了差不多一个字". A proportion cannot
           land on a centre line, and a gap is not nothing.
        3. Row `basis-1/2` with `justify-between`, **with the row direction and
           every shrink rule hidden behind a `min-[360px]:` variant**. On his
           phone that variant did not match, so the section stayed `flex-col` —
           while the `min-w-0` that keeps the date input from forcing its
           intrinsic width was behind the same variant and therefore also absent.
           The date input took its full intrinsic width, blew out its own column,
           and pushed the time field off the right edge.

        **The lesson from (3) is the one that generalises**: a rule that *must*
        hold was written inside a conditional that might not. `min-w-0` is not a
        nicety here — it is the thing that stops Safari's date input from
        insisting on its minimum — so it belongs where it always applies.

        **Two rows**, which is what the owner asked for after seeing (3), and
        which removes the whole class of problem: one field per row cannot be
        squeezed by its neighbour, whatever the intrinsic minimum is. It costs
        vertical space and buys certainty, and the certainty is worth more on a
        form somebody fills in one-handed.
      */}
      <Field label="日期">
        <input
          type="date"
          value={value.date}
          onChange={(event) => {
            patch({ date: event.target.value });
          }}
          className="w-full min-w-0 rounded-field border border-line bg-surface px-3 py-2.5 text-base text-ink outline-none focus:border-brand"
        />
      </Field>

      <Field label="时间">
        <input
          type="time"
          value={value.time}
          onChange={(event) => {
            patch({ time: event.target.value });
          }}
          className="w-full min-w-0 rounded-field border border-line bg-surface px-3 py-2.5 text-base text-ink outline-none focus:border-brand"
        />
      </Field>

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
          className="w-full rounded-field border border-line bg-surface px-3 py-2.5 text-base text-ink outline-none placeholder:text-muted/80 focus:border-brand"
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

      <button type="button" onClick={onManual} className="text-helper text-muted underline">
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
      <span className="text-helper text-muted">{label}</span>
      {children}
    </label>
  );
}

/** Build the form's starting values from one recognition result. */

