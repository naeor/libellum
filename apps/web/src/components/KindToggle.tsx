import type { TransactionKind } from "@libellum/shared";

/**
 * Expense or income.
 *
 * Two shapes of the same control, because the ledger screen shows it in two
 * places: beside the island inside the green summary, and filling the compact
 * bar once the summary has scrolled away. Both are pill-shaped tracks with a
 * raised selected segment — a segmented control rather than two loose buttons,
 * because the track is what says "pick one of these" instead of "here are two
 * things to press".
 */
export function KindToggle({
  kind,
  onChange,
  variant,
}: {
  readonly kind: TransactionKind;
  readonly onChange: (kind: TransactionKind) => void;
  /** `compact` is the smaller form used in the sticky bar. */
  readonly variant: "compact" | "inline";
}): React.JSX.Element {
  const options: readonly TransactionKind[] = ["expense", "income"];

  if (variant === "compact") {
    return (
      <div className="flex flex-1 gap-1 rounded-full bg-white/25 p-1" role="group" aria-label="收支类型">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={kind === option}
            onClick={() => {
              onChange(option);
            }}
            className={`flex-1 rounded-full py-1.5 text-sm font-medium transition ${
              kind === option ? "bg-white text-brand-dark shadow-sm" : "text-white/85"
            }`}
          >
            {option === "expense" ? "支出" : "收入"}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="flex gap-1 rounded-full bg-black/12 p-1" role="group" aria-label="收支类型">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={kind === option}
          onClick={() => {
            onChange(option);
          }}
          className={`rounded-full px-4 py-2 text-sm font-medium transition ${
            kind === option ? "bg-white text-brand-dark shadow-sm" : "text-white/85"
          }`}
        >
          {option === "expense" ? "支出" : "收入"}
        </button>
      ))}
    </div>
  );
}
