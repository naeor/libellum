import { Link } from "react-router";

/**
 * A titled card — **the same shape `StatsPage` established**, now shared.
 *
 * ⚠️ **It was copied into `LedgerPage` first, and that was the right order.** Lifting it out
 * immediately would have meant editing the analysis screen inside a change about the ledger screen;
 * **the third caller is when sharing it stops being speculative.**
 *
 * ⚠️ **`StatsPage` still has its own copy.** Converting that file is a separate, small change — and
 * doing it here would put the analysis screen in this diff for no functional reason.
 */
export function Section({
  title,
  action,
  children,
}: {
  readonly title: string;
  readonly action?: { readonly to: string; readonly label: string };
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="flex flex-col px-6 pt-7">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-ink">{title}</h2>
        {action === undefined ? null : (
          <Link to={action.to} className="text-xs text-brand transition hover:text-brand-dark">
            {action.label} ›
          </Link>
        )}
      </div>
      <div className="rounded-card border border-line bg-surface p-4">{children}</div>
    </section>
  );
}
