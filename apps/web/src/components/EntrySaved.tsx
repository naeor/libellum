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
 * ⚠️ **Two corrections the owner made after using it on his phone**, both about
 * the same thing: the screen spent its height on breathing room and pushed the
 * buttons out of reach.
 *
 *  * the gaps were large enough that the buttons sat **below the fold** — he had
 *    to scroll to reach them, on a screen whose whole job is one tap. The mark is
 *    smaller and the spacing is measured now.
 *  * in a **batch** it offered 返回主页 as well as 继续记账. Going home mid-batch
 *    abandons the screenshots still waiting to be checked, and those are the
 *    reason the person is on this screen at all. Batch mode now has one button,
 *    and it says how much is left.
 *
 * The mark is a placeholder in the theme colour. Art can replace it without
 * touching anything else — and deliberately without animation: a confirmation
 * that moves is one more thing to wait for.
 */
export function EntrySaved({
  entry,
  categoryName,
  paymentName,
  remaining,
  onHome,
  onAgain,
  onUndo,
}: {
  readonly entry: Transaction;
  readonly categoryName: string;
  readonly paymentName: string | null;
  /**
   * How many entries still need checking **after this one**.
   *
   * Zero means this was the last, so the screen offers 返回主页. Any other value
   * means a batch is still in progress, so it offers only 继续记账 — and says how
   * many are left, because "继续" without a number leaves somebody wondering
   * whether they are nearly done.
   */
  readonly remaining: number;
  readonly onHome: () => void;
  readonly onAgain: () => void;
  /**
   * Take this entry back.
   *
   * The owner asked for it on this screen rather than in the ledger, and the
   * arithmetic is his: fixing a wrong amount used to mean finding the entry in
   * the list and editing it — six steps — where the moment after saving is
   * exactly when the mistake is noticed. One tap here replaces all of them.
   *
   * Absent means no undo is offered, which is the case on the manual form where
   * the fields are still on screen behind this one.
   */
  readonly onUndo?: (() => void) | undefined;
}): React.JSX.Element {
  const detail = [categoryName, paymentName].filter((part) => part !== null && part !== "").join(" · ");
  const inBatch = remaining > 0;

  return (
    <main
      role="status"
      aria-live="polite"
      className="flex h-dvh flex-col items-center justify-center gap-1 bg-surface px-8"
    >
      <CheckMark />

      {/*
        `mt-2`, down from `mt-5`. The owner's note was precise about where the
        height was going: the space between the mark and the text below it. Eight
        pixels instead of twenty-eight is the difference between reaching the
        button and scrolling to it on a phone.
      */}
      <h1 className="mt-2 text-lg font-semibold text-ink">已记账</h1>

      <p className="text-3xl font-medium tabular-nums text-ink">
        {formatMoney(entry.amountCents, entry.currency)}
      </p>

      {detail === "" ? null : <p className="text-sm text-muted">{detail}</p>}

      <div className="mt-7 flex w-full max-w-xs flex-col gap-3">
        <Button onClick={onAgain}>
          {inBatch ? `继续记账（还有 ${String(remaining)} 张）` : "再记一笔"}
        </Button>

        {/*
          No way home mid-batch. The screenshots still waiting are the reason the
          person is here, and an exit sitting beside "continue" invites losing
          them. On the last entry of a batch this is the only button, which is
          what finishing should offer.
        */}
        {inBatch ? null : (
          <Button variant="secondary" onClick={onHome}>
            返回主页
          </Button>
        )}

        {/*
          The undo, quiet and last.

          Quiet because it is not what most people want here — a screen that
          shouts "undo" invites the doubt it is meant to remove. Last because the
          eye should reach "record the next one" first.

          Its own handler deletes the entry rather than navigating anywhere, so
          the mistake is fixed where it was made instead of sending the user off
          to find the row in a list.
        */}
        {onUndo === undefined ? null : (
          <button
            type="button"
            onClick={onUndo}
            className="mt-1 text-xs text-muted underline transition hover:text-ink"
          >
            撤销这次记账
          </button>
        )}
      </div>
    </main>
  );
}

function CheckMark(): React.JSX.Element {
  return (
    <svg width="84" height="84" viewBox="0 0 104 104" aria-hidden="true">
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
