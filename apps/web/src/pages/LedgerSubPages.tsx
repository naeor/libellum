import { Link } from "react-router";

import { InnerPage } from "../components/Layouts.js";
import { MemberList } from "../components/MemberList.js";
import { SkeletonRows } from "../components/States.js";
import { useBooks, useLedger } from "../lib/queries.js";

/**
 * **「账本 / 协作」主 Tab 下面的三个二级页面。**
 *
 * ⚠️ **These are B-class screens and they look like it on purpose** — white background, a simple
 * title, a back control, `rounded-card` blocks. That style was never wrong; **it was in the wrong
 * place.** The owner's diagnosis: *"这类风格并没有问题，只是它应该用在二级页面，而不是一级 Tab 页面上."*
 *
 * ⚠️ **All three return to `/ledger`**, and the frame's back control prefers real history over that
 * fallback (`useGoBack`), so arriving from the tab and going back lands on the tab.
 */

/** **完整账本信息** —— what the main tab previews four facts of. */
export function LedgerInfoPage(): React.JSX.Element {
  const ledger = useLedger();
  const books = useBooks();
  const stats = ledger.data?.stats;

  return (
    <InnerPage title="账本信息" subtitle={ledger.data?.book.name ?? "正在读取……"} backTo="/ledger">
      {ledger.isPending ? <SkeletonRows rows={3} /> : null}

      {ledger.isSuccess ? (
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-3 rounded-card border border-line bg-surface p-5 text-sm">
          <dt className="text-muted">账本名称</dt>
          <dd className="text-right text-ink">{ledger.data.book.name}</dd>

          <dt className="text-muted">账本编号</dt>
          <dd className="text-right font-mono text-ink">
            {ledger.data.book.bookNumber ?? "（未分配）"}
          </dd>

          <dt className="text-muted">成员数量</dt>
          <dd className="text-right text-ink">{String(ledger.data.book.memberCount ?? 1)} 人</dd>

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

          {books.isSuccess ? (
            <>
              <dt className="text-muted">你的账本总数</dt>
              <dd className="text-right text-ink">{String(books.data.books.length)} 本</dd>
            </>
          ) : null}
        </dl>
      ) : null}

      <p className="text-xs leading-relaxed text-muted">
        占用空间没有列在这里：它是一个估算值，而在这一页里它会被当成精确值来读。
        需要时主页面上有一行「约 …」的提示。
      </p>

      <Link to="/start" className="text-sm text-brand transition hover:text-brand-dark">
        前往账本空间 ›
      </Link>
    </InnerPage>
  );
}

/** **成员管理** —— 改权限、移出。 */
export function LedgerMembersPage(): React.JSX.Element {
  const ledger = useLedger();

  return (
    <InnerPage title="成员管理" subtitle={ledger.data?.book.name ?? "正在读取……"} backTo="/ledger">
      {/**
        * ⚠️ **The full-strength list, controls included** — this is the page the main tab's
        * 「管理」 link opens, and the reason the tab itself can stay a preview.
        */}
      <MemberList />
    </InnerPage>
  );
}

/**
 * **邀请成员。**
 *
 * ⚠️ **Two different invitations, and this page says which is which** — the owner separated them
 * himself: a referral code creates an **account**, a share link joins **this ledger**. He also moved
 * the referral code to 账户: *"前者属于账号级功能……不需要占据当前账本的协作页面."*
 *
 * ⚠️ **So this page never mentions邀请码.** It offers what belongs to *this ledger*, and points at
 * 账户 for the other — **a screen that explains the difference is a screen that admits the two are
 * easy to confuse**, and the cheapest way to keep them apart is to not show both.
 */
export function LedgerInvitePage(): React.JSX.Element {
  const ledger = useLedger();

  return (
    <InnerPage
      title="邀请成员"
      subtitle={`把别人请进「${ledger.data?.book.name ?? "这本账"}」`}
      backTo="/ledger"
    >
      <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-5">
        <h2 className="text-sm font-medium text-ink">邀请某个人</h2>
        <p className="text-sm leading-relaxed text-muted">
          在「协作者」页面按对方账号编号找到他，然后邀请他加入这本账。
          他会收到一条通知，他同意之后才真正加入。
        </p>
        <Link
          to="/collaborators"
          className="inline-flex self-start rounded-field bg-brand px-4 py-2.5 text-sm text-white transition hover:bg-brand-dark"
        >
          去邀请
        </Link>
      </div>

      <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-5">
        <h2 className="text-sm font-medium text-ink">已经在账本里的人</h2>
        <MemberList />
      </div>

      <p className="text-xs leading-relaxed text-muted">
        用于注册账号的邀请码不在这里——它属于账号本身，在「账户」页面。
        这里发出的邀请只关于当前这本账。
      </p>
    </InnerPage>
  );
}
