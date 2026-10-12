import { InnerPage } from "../components/Layouts.js";

/**
 * **账本空间 —— 目前是一个占位页。**
 *
 * ⚠️ **The owner explicitly allowed this to be empty for now**: *"切换账本所在的页面还没有做出来，
 * 可以先不急着做——你可以先做一个空白的'开始'页面，切换账本页面能跳转到那里就行."*
 *
 * So this exists to give the ledger switcher somewhere to go, and **nothing more**. It is not the
 * finished 账本空间 — that is specified in `档案/账本与协作页-设计决定.md` §2.4, and building it
 * here would mean building it before the page it belongs to has been designed in code.
 *
 * ⚠️ **It says what it is rather than pretending to be finished.** A blank screen with a heading
 * reads as "the app is broken"; a screen that states it is a placeholder reads as "not yet" —
 * **and the second is true.** `教训.md` §8.6 is about the difference.
 *
 * ⚠️ **The real page will replace this file, not grow beside it.** When the ledger space arrives,
 * `/start` becomes it and this notice goes away; keeping a second "real" page at another route is
 * how two screens come to disagree about which ledger is current.
 */
export function StartPage(): React.JSX.Element {
  return (
    <InnerPage title="账本空间" subtitle="这里将来是所有账本的总览：查看、新建、进入、管理。" backTo="/">
      <div className="rounded-card border border-line bg-surface p-5">
        <p className="text-sm leading-relaxed text-ink">这个页面还没有做。</p>

        <p className="mt-3 text-xs leading-relaxed text-muted">
          它将承担三件事：列出你的全部账本、新建一本账，以及账本层面的管理
          （改名、弃置、恢复、退出）。
        </p>

        <p className="mt-3 text-xs leading-relaxed text-muted">
          现在可以先从「账户 → 我的账本」完成新建与切换——那里已经能用了。
        </p>
      </div>
    </InnerPage>
  );
}
