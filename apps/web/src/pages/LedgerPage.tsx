import { Link } from "react-router";

import { HistoryList } from "../components/HistoryList.js";
import { InnerPage } from "../components/Layouts.js";
import { MemberList } from "../components/MemberList.js";
import { MessageBoard } from "../components/MessageBoard.js";
import { SkeletonRows } from "../components/States.js";
import { useBooks, useLedger } from "../lib/queries.js";

/**
 * A rough size for one ledger's rows.
 *
 * ⚠️ **Deliberately an estimate, and the constants are deliberately round.** PostgreSQL keeps table
 * bytes per table, not per owning ledger, so an exact answer means measuring each row's payload —
 * **real work for a figure nobody makes a decision with.** What the row is for is *"is this ledger
 * small or is it growing"*, and 1 KB per entry / 0.5 KB per history event answers that honestly.
 *
 * ⚠️ **The uncertainty is disclosed in the UI, not hidden here** (see the 约 in the label). A number
 * shown beside exact counts will be read as exact, **and somebody will eventually reconcile against
 * it.**
 */
function estimateBytes(transactionCount: number, eventCount: number): number {
  return transactionCount * 1024 + eventCount * 512;
}

/** KB / MB, with one decimal — enough to see a change, not enough to imply precision. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * **账本 / 协作 —— 当前账本的信息中心。**
 *
 * ⚠️ **One page with two emphases, not two pages.** The owner's rule:
 *
 * > *"只有自己一位成员时，显示「账本」。有两位或以上成员时，显示「协作」。……
 * >  这两个名称对应的实际上是**同一个功能空间**，页面的整体设计语言保持一致，
 * >  但**展示重点和内容布局根据成员数量自动变化**。"*
 *
 * ⚠️ **And it must answer three questions** — *"这是什么账本？谁在使用它？这本账最近发生了什么？"* —
 * which is why the page is ordered: **which ledger** (info), **who is in it** (members), **what
 * happened** (history). The order is the answer, not a layout preference.
 *
 * ⚠️ **This is P4: the skeleton.** The sections below are real but shallow — the account space entry
 * and the ledger info are done; **member management (P7) and the history list (P6) are stubs that
 * say so**. Building them here would mean building them before the data underneath exists.
 */
export function LedgerPage(): React.JSX.Element {
  const ledger = useLedger();
  const books = useBooks();

  const members = ledger.data?.book.memberCount ?? 1;
  const shared = members >= 2;
  const stats = ledger.data?.stats;
  const current = books.data?.books.find((book) => book.id === ledger.data?.book.id) ?? null;

  return (
    <InnerPage
      title={shared ? "协作" : "账本"}
      subtitle={ledger.data?.book.name ?? "正在读取当前账本……"}
      backTo="/"
    >
      <div className="flex flex-col gap-6">
        {ledger.isPending ? <SkeletonRows rows={2} /> : null}

        {ledger.isSuccess ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm text-muted">这本账</h2>

            <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-3 rounded-card border border-line bg-surface p-5 text-sm">
              <dt className="text-muted">账本名称</dt>
              <dd className="text-right text-ink">{ledger.data.book.name}</dd>

              <dt className="text-muted">账本编号</dt>
              <dd className="text-right font-mono text-ink">
                {ledger.data.book.bookNumber ?? "（未分配）"}
              </dd>

              {stats === undefined ? null : (
                <>
                  <dt className="text-muted">创建时间</dt>
                  <dd className="text-right text-ink">{stats.createdAt.slice(0, 10)}</dd>

                  <dt className="text-muted">账目数量</dt>
                  <dd className="text-right text-ink">{String(stats.transactionCount)} 笔</dd>

                  <dt className="text-muted">编辑记录</dt>
                  <dd className="text-right text-ink">{String(stats.eventCount)} 条</dd>
                </>
              )}

              <dt className="text-muted">成员数量</dt>
              <dd className="text-right text-ink">{String(members)} 人</dd>
            </dl>

            {/**
              * ⚠️ **"占用空间" is an estimate, and it says so.**
              *
              * PostgreSQL does not attribute table bytes to a row's owning ledger, so an exact figure
              * would mean measuring per-ledger row payloads — **real work for a number nobody acts
              * on.** What a person actually wants from this row is *"is this ledger tiny or is it
              * getting big"*, and an approximation answers that.
              *
              * ⚠️ **A bare "1.2 MB" beside four exact figures would read as exact**, which is why
              * the word 约 is there. **An estimate presented as a measurement is worse than no
              * number**, because somebody will eventually reconcile against it.
              */}
            {stats === undefined ? null : (
              <p className="text-xs leading-relaxed text-muted">
                占用空间：约 {formatBytes(estimateBytes(stats.transactionCount, stats.eventCount))}。
                这里只显示用来认出「这是哪本账」的信息，收支统计在「分析」页面。
              </p>
            )}
          </section>
        ) : null}

        {/**
          * ⚠️ **The ledger-space entry, and it must not be buried.** The owner:
          * *"我希望这是一个正式、明显而且容易理解的入口，而不是隐藏在很多层设置里"* and
          * *"它在个人账本和共享账本中都应始终存在."*
          */}
        <section className="flex flex-col gap-3">
          <h2 className="text-sm text-muted">账本空间</h2>

          <Link
            to="/start"
            className="flex items-center justify-between gap-4 rounded-card border border-line bg-surface px-5 py-4 transition hover:bg-canvas"
          >
            <span className="flex flex-col gap-0.5">
              <span className="text-sm text-ink">查看全部账本、切换或新建</span>
              <span className="text-xs text-muted">
                当前：{ledger.data?.book.name ?? "……"}
                {books.isSuccess ? ` · 共 ${String(books.data.books.length)} 本` : ""}
              </span>
            </span>
            <span aria-hidden="true" className="text-muted">
              ›
            </span>
          </Link>
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm text-muted">编辑历史</h2>
            {/**
              * ⚠️ **The entry the owner asked for**: *"主页面可以预览最近几条历史，并提供入口查看更
              * 完整的记录."* A preview with no way to the rest is a dead end.
              */}
            <Link to="/ledger/history" className="text-xs text-brand transition hover:text-brand-dark">
              查看全部 ›
            </Link>
          </div>

          {/**
            * ⚠️ **The preview the owner asked for**: *"主页面可以预览最近几条，并提供入口查看更完整的
            * 记录."* Six is enough to see that something happened; the full view is P6's next step.
            *
            * ⚠️ **And `emptyHint` says why it can be empty**, because the events only start when the
            * feature did — **"this ledger has never changed" and "the record starts here" are
            * different statements, and a blank area cannot tell them apart.**
            */}
          <HistoryList
            limit={6}
            emptyHint="这本账还没有改动记录。改动记录从这个功能上线之后开始，之前的操作不会补记。"
          />
        </section>

        {/**
          * ⚠️ **The member area, and what it shows depends on the count** — this is the "两种侧重"
          * the owner asked for, in its first and simplest form.
          */}
        <section className="flex flex-col gap-3">
          <h2 className="text-sm text-muted">{shared ? "成员" : "邀请"}</h2>

          {/**
            * ⚠️ **The member list is the same component in both states** — one member or five. The
            * owner's rule is that the two labels are *"同一个功能空间"* with a different emphasis, so
            * showing the list always (rather than only when shared) keeps that true; **what changes is
            * how much room it gets, not whether it exists.**
            *
            * ⚠️ **And the invitation entry stays visible on a one-person ledger**, which the owner
            * asked for: *"即使当前只有自己一位成员，也应当保留「邀请协作者」入口."*
            */}
          {!shared ? (
            <p className="text-xs leading-relaxed text-muted">
              这本账现在只有你一个人。邀请别人加入之后，它就成为共享账本。
            </p>
          ) : null}

          <MemberList />

          <Link to="/collaborators" className="text-xs text-brand transition hover:text-brand-dark">
            邀请新成员 ›
          </Link>
        </section>

        {/**
          * ⚠️ **The message board appears only on a shared ledger, and that follows the owner's
          * structure rather than hiding a feature.** His design gives the page **two emphases**: with
          * one member it is *"相对安静，强调账本信息与历史"*, and the shared one is where
          * *"成员、留言和协作动态"* live.
          *
          * ⚠️ **A board on a one-person ledger would be a room with one chair** — and he is explicit
          * that the shared state is not a different product but **the same page, emphasised
          * differently** (*"随着使用人数自然改变自己的侧重点"*).
          */}
        {shared ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm text-muted">留言</h2>
            <MessageBoard />
          </section>
        ) : null}

        {/**
          * ⚠️ **The account-level invitation code is NOT here, and that is deliberate.**
          *
          * My first version of this page rendered `ReferralCodeSection` at the bottom — it looked
          * helpful, and it directly contradicts what the owner said when he moved it:
          * *"前者属于账号级功能，适合放在「账户」的相关设置中，**不需要占据当前账本的协作页面**."*
          *
          * ⚠️ **"It is convenient here too" is not a reason to overrule a placement decision** —
          * and this is the second time in one stage that the same instruction nearly got undone by a
          * helpful-looking addition (`教训.md` §8.13).
          *
          * It lives on 账户. This page links to the people who are already in the ledger.
          */}
      </div>
    </InnerPage>
  );
}
