import type { Transaction } from "@libellum/shared";

import { Button } from "./Button.js";
import { formatMoney } from "../lib/format.js";

/**
 * What the screen says after an entry is saved.
 *
 * The form is replaced rather than annotated, because the previous feedback —
 * a line of green text above a still-filled form — left people unsure whether
 * the entry had actually been recorded. A confirmation that can be mistaken
 * for a validation hint is not a confirmation.
 *
 * Three things it deliberately does:
 *
 *  * **states the amount**, not just that something happened. "Saved" is only
 *    reassuring if you can see *what* was saved, and the amount is the part a
 *    person checks.
 *  * **offers the repeat action first.** This screen appears after every save,
 *    and recording a day's spending means several in a row; going home is one
 *    tap on the secondary button either way.
 *  * **announces itself** via `role="status"`, so a screen reader is told the
 *    entry was recorded instead of meeting a silent, changed screen.
 *
 * The mark is a placeholder in the theme colour. Art can replace it without
 * touching anything else — and deliberately without animation: a confirmation
 * that moves is one more thing to wait for.
 */
export function EntrySaved({
  entry,
  categoryName,
  paymentName,
  onHome,
  onAgain,
}: {
  readonly entry: Transaction;
  readonly categoryName: string;
  readonly paymentName: string | null;
  readonly onHome: () => void;
  readonly onAgain: () => void;
}): React.JSX.Element {
  const detail = [categoryName, paymentName].filter((part) => part !== null && part !== "").join(" · ");

  return (
    <main
      role="status"
      aria-live="polite"
      className="flex h-dvh flex-col items-center justify-center gap-2 bg-surface px-8"
    >
      <CheckMark />

      <h1 className="mt-5 text-lg font-semibold text-ink">已记账</h1>

      <p className="text-3xl font-medium tabular-nums text-ink">
        {formatMoney(entry.amountCents, entry.currency)}
      </p>

      {detail === "" ? null : <p className="text-sm text-muted">{detail}</p>}

      <div className="mt-9 flex w-full max-w-xs flex-col gap-3">
        <Button onClick={onAgain}>再记一笔</Button>
        <Button variant="secondary" onClick={onHome}>
          返回主页
        </Button>
      </div>
    </main>
  );
}

function CheckMark(): React.JSX.Element {
  return (
    <svg width="104" height="104" viewBox="0 0 104 104" aria-hidden="true">
      <circle cx="52" cy="52" r="48" className="fill-brand-soft" />
      <path
        d="M34 54 L46 66 L70 40"
        fill="none"
        strokeWidth={7}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-brand"
      />
    </svg>
  );
}
