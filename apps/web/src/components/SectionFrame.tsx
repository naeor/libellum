import { Link } from "react-router";

/**
 * **A functional block on a first-level page: a heading row, then one frame.**
 *
 * ⚠️ **This is not `Section`, and the difference is the whole point of S11 第一阶段补充.**
 * `Section` puts its children *inside* a card — which is right when the child is a summary object
 * and wrong when the child is a list, because the list brings its own frame and the page ends up
 * **a box inside a box inside a heading**. The owner described exactly that:
 *
 * > *"当前协作页空间利用率偏低，存在明显的'盒子套盒子'问题……很多内容只是列表或预览，却被多层容器包裹，
 * >  导致手机上显得拥挤但信息密度又低."*
 *
 * ⚠️ **So the rule this component encodes** (his §7, verbatim in intent):
 *
 * | 内容 | 容器 |
 * |---|---|
 * | 摘要对象 / 概览 | **卡片** — `Section` |
 * | 小列表 / 复合功能区 | **一个总外框** — this component |
 * | 局部操作区、外框内部的条目 | **直接排列，不套卡片** |
 *
 * ⚠️ **The children are expected to be frameless.** Nothing here wraps them: whatever renders below
 * the heading is the content, and if it grows a `rounded-card border` of its own the nesting is
 * back. That is why the lists on this page take an `embedded` flag — see `HistoryList`,
 * `MessageBoardCard`.
 *
 * ⚠️ **The heading sits outside the frame, and the action is green text rather than a button.** The
 * owner: *"标题和操作在总外框外部；右侧操作用绿色文字，不做大按钮"* and — for the whole family of
 * secondary actions — *"不要把这些全部做成实体按钮。它们属于次级操作入口，优先使用绿色文字 +
 * 轻量交互状态."*
 */
export function SectionFrame({
  title,
  action,
  children,
  bare = false,
  titleClassName = "section-title",
}: {
  readonly title: string;
  /** The right-hand links, in the order they should read. Green text, never buttons. */
  readonly action?: React.ReactNode;
  readonly children: React.ReactNode;
  /**
   * ⚠️ **Skip the frame entirely, for a section that is a local *operation* rather than a list.**
   * The owner's third container rule: *"一级页面内的局部操作区域……直接开放式结构."* The heading row
   * still appears; only the border and surface colour are dropped, because **a frame around a single
   * input is a box around a box** — the input has its own edge.
   */
  readonly bare?: boolean;
  /**
   * ⚠️ **The heading's typography, overridable for the same reason as `Section`'s** — the owner
   * scoped the 16px experiment to 分析 and 账本／协作, and this component is the heading of two of
   * that page's sections. **The default is the shared token**; the default is what the whole app
   * gets the day the experiment is approved.
   */
  readonly titleClassName?: string;
}): React.JSX.Element {
  return (
    <section className="flex flex-col px-6 pt-7">
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h2 className={titleClassName}>{title}</h2>
        {action === undefined ? null : (
          <span className="flex shrink-0 items-baseline gap-3 text-xs">{action}</span>
        )}
      </div>

      {bare ? (
        children
      ) : (
        <div className="overflow-hidden rounded-card border border-line bg-surface">{children}</div>
      )}
    </section>
  );
}

/**
 * A secondary action in a heading row — **green text, with a light touch state.**
 *
 * ⚠️ **It exists as a component so the colour and the size cannot drift across the six places the
 * owner listed** (`查看全部` · `展开完整对话` · `新消息 N 条` · `账本详情` · `切换账本` · `成员管理`).
 * Six hand-written class strings is six chances for one of them to be a button again.
 */
export function FrameAction({
  to,
  children,
  onClick,
}: {
  /** ⚠️ Omitted for an action that does something rather than goes somewhere. */
  readonly to?: string;
  readonly children: React.ReactNode;
  readonly onClick?: () => void;
}): React.JSX.Element {
  const className = "text-brand transition hover:text-brand-dark";

  if (to !== undefined) {
    return (
      <Link to={to} className={className}>
        {children}
      </Link>
    );
  }

  return (
    <button type="button" onClick={onClick} className={className}>
      {children}
    </button>
  );
}
