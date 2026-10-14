/**
 * **A first-level page's green heading area — one component, so two screens cannot disagree.**
 *
 * ⚠️ **Why this exists rather than two matching `<header>` blocks.** 分析 and 账本／协作 had
 * **byte-identical headers** for the title and subtitle, kept in step by hand. That is the arrangement
 * that drifts: somebody adjusts the padding on one screen, nothing fails, and the difference is only
 * visible to a person looking at both. The owner asked for the structural fix explicitly —
 * *"不要只是把分析页的标题往上或往下挪几个像素……尽可能复用相同的标题区布局规则或共享样式，保证以后修改时
 * 不会再次出现差异."* **So the spec lives here once, and the screens have no opinion about it.**
 *
 * ⚠️ **What is deliberately *not* here.** The per-page action (账本／协作's notification bell) is a
 * **slot**, not a rule — the owner kept that distinction: *"如果账本／协作页顶部有通知铃铛等独有操作，应予
 * 保留；分析页不需要为了统一而增加相同功能。统一的是标题区域的视觉规格，不是强迫两个页面的内容完全相同."*
 * So the title block is fixed and the right-hand side is whatever the page passes.
 *
 * ⚠️ **The subtitle is always rendered, even before the page's data arrives.** It used to be
 * conditional on `ledger.isSuccess` on the ledger tab — **which made that header one line shorter
 * while loading and then jump**, and would have made the two screens disagree during exactly the
 * moment a reader switching tabs is looking at both. The subtitle is static text; there is no reason
 * to withhold it. **A height that depends on a request is a layout that moves.**
 */
export function TabPageHeader({
  title,
  subtitle,
  action,
}: {
  readonly title: string;
  readonly subtitle: string;
  /** The page's own controls, if it has any. **Omitted by pages that need none.** */
  readonly action?: React.ReactNode;
}): React.JSX.Element {
  return (
    /**
      * ⚠️ **These classes are the spec the owner asked to unify**: height from `pt-8 pb-6`, horizontal
      * rhythm from `px-6`, `bg-brand` for the fill. Tailwind has no "same height as that other header"
      * primitive, so **one class string used by both screens is the enforcement** — there is no second
      * copy to edit.
      */
    <header className="bg-brand px-6 pt-8 pb-6 text-white">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {/**
            * ⚠️ **`text-page-title`**, and no colour class: the header sets
            * `text-white`, so the title inherits it. **Adding `text-white` here would be a second place
            * saying the same thing**, and the day the header changes colour the title would not follow.
            */}
          <h1 className="text-page-title">{title}</h1>
          {/**
            * ⚠️ **`mt-1.5 text-body-relaxed text-white/80`** — the exact gap and weight both
            * screens already used. **`leading-relaxed` matters more than it looks**: the subtitle is
            * allowed to wrap to two lines at 320 px, and the tighter default would change the header's
            * height between phones.
            *
            * ⚠️ **The colour is no longer `/80`.** White at 80% over the brand green composites to
            * `#ddebe4` — **2.74:1**, which is half the AA requirement for text this size. Full white
            * reaches **3.37:1**: better, and *still below AA*.
            *
            * ⚠️ **And that ceiling is the point: it is not fixable with opacity.** Pure white on
            * `#55997a` is 3.37:1, so **no alpha value can reach 4.5** — the limit belongs to the brand
            * green being light, not to this paragraph. Reaching AA would mean darkening the brand
            * (rejected: it is the identity) or enlarging the subtitle to 18.66 px bold (rejected: it
            * is a subtitle). **So this is recorded as a known limit rather than quietly "fixed", and
            * full white is taken because it is the best available within the constraint** — it is a
            * supplementary sentence, not an instruction anyone has to act on.
            */}
          <p className="mt-1.5 text-body-relaxed text-white">{subtitle}</p>
        </div>

        {action}
      </div>
    </header>
  );
}
