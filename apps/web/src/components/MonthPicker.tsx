import { currentMonth } from "../lib/datetime.js";

const MONTH_NAMES = [
  "1 月",
  "2 月",
  "3 月",
  "4 月",
  "5 月",
  "6 月",
  "7 月",
  "8 月",
  "9 月",
  "10 月",
  "11 月",
  "12 月",
] as const;

/**
 * Choosing a month.
 *
 * A bottom sheet rather than a dropdown: on a phone a menu anchored to a small
 * button is a small target with a list that may open off-screen, while a sheet
 * is reachable with a thumb and holds all twelve months at once — which is the
 * point, since the reason to open it is to get to a month the arrows would take
 * several taps to reach.
 *
 * The year steps independently, so going back a year is one tap rather than
 * twelve.
 */
export function MonthPicker({
  open,
  month,
  onSelect,
  onClose,
  maxMonth,
}: {
  readonly open: boolean;
  readonly month: string;
  readonly onSelect: (month: string) => void;
  readonly onClose: () => void;
  /** Months after this one are shown but cannot be chosen. */
  readonly maxMonth: string;
}): React.JSX.Element | null {
  if (!open) return null;

  const year = Number(month.slice(0, 4));

  const step = (delta: number): void => {
    const next = year + delta;
    // Keep the month, clamp to something that exists.
    onSelect(`${String(next)}-${month.slice(5, 7)}`);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <button
        type="button"
        aria-label="关闭月份选择"
        onClick={onClose}
        className="absolute inset-0 bg-ink/35"
      />

      <div
        role="dialog"
        aria-label="选择月份"
        className="relative w-full max-w-md rounded-t-card bg-surface px-6 pt-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))] shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <button
            type="button"
            aria-label="上一年"
            onClick={() => {
              step(-1);
            }}
            className="rounded-full px-3 py-2 text-muted transition hover:text-ink"
          >
            ‹
          </button>

          <span className="text-base font-medium tabular-nums text-ink">{year} 年</span>

          <button
            type="button"
            aria-label="下一年"
            onClick={() => {
              step(1);
            }}
            className="rounded-full px-3 py-2 text-muted transition hover:text-ink"
          >
            ›
          </button>
        </div>

        <ul className="grid grid-cols-3 gap-2">
          {MONTH_NAMES.map((name, index) => {
            const value = `${String(year)}-${String(index + 1).padStart(2, "0")}`;
            const selected = value === month;
            const future = value > maxMonth;

            return (
              <li key={value}>
                <button
                  type="button"
                  disabled={future}
                  aria-pressed={selected}
                  onClick={() => {
                    onSelect(value);
                    onClose();
                  }}
                  className={`w-full rounded-field py-3 text-sm transition ${
                    selected
                      ? "bg-brand text-white"
                      : future
                        ? "text-muted/40"
                        : "bg-canvas text-ink hover:bg-brand-soft"
                  }`}
                >
                  {name}
                </button>
              </li>
            );
          })}
        </ul>

        <button
          type="button"
          onClick={() => {
            onSelect(currentMonth());
            onClose();
          }}
          className="mt-4 w-full rounded-field bg-brand-soft py-3 text-sm font-medium text-brand-dark transition hover:bg-brand-soft/70"
        >
          回到本月
        </button>
      </div>
    </div>
  );
}
