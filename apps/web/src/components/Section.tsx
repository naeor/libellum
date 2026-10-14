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
  titleClassName = "section-title",
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
  /**
   * ⚠️ **The heading's typography, overridable so the 16px experiment stays inside its two pages.**
   *
   * The owner scoped the experiment: *"先只在「分析」和「账本／协作」两个一级页面进行视觉试验……
   * 不要直接批量修改全站."* **`Section` is also used by 设置、关于 and others**, so changing its
   * heading here would have moved several pages at once — the opposite of an experiment.
   *
   * ⚠️ **The default is the shared semantic token**, so a caller that passes nothing gets the real
   * spec and no page has to restate it. **When the experiment is approved, the *token* moves and
   * every caller follows** — which is the entire reason for naming the role rather than the size.
   */
  readonly titleClassName?: string;
}): React.JSX.Element {
  return (
    <section className={`flex flex-col px-6 pt-7 ${animate ? "section-in" : ""}`}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className={titleClassName}>{title}</h2>
        {action === undefined ? null : (
          <Link to={action.to} className="text-helper text-brand transition hover:text-brand-dark">
            {action.label} ›
          </Link>
        )}
      </div>
      <div className="rounded-card border border-line bg-surface p-4">{children}</div>
    </section>
  );
}
