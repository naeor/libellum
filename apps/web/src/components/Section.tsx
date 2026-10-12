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
  animate = true,
}: {
  readonly title: string;
  readonly action?: { readonly to: string; readonly label: string };
  readonly children: React.ReactNode;
  /**
   * ⚠️ **On by default, and on for every section rather than only the ones that come and go.**
   *
   * The sections that appear with the second member are what the owner wanted animated
   * (*"状态变化可以有轻微自然的过渡"*), but **animating only those would make the change look like a
   * special case** — two sections sliding in while the rest sit still. Animating all of them means a
   * section arriving is simply how this page works, **and the transition stops being an event.**
   *
   * ⚠️ **A section already mounted when the count changes does not replay it**, which is what makes
   * the two states feel like one page rather than two screens.
   */
  readonly animate?: boolean;
}): React.JSX.Element {
  return (
    <section className={`flex flex-col px-6 pt-7 ${animate ? "section-in" : ""}`}>
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
