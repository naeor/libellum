import { useState } from "react";
import { Link, useNavigate } from "react-router";

import { useAuth } from "../auth/AuthProvider.js";
import { DefaultAvatar } from "../components/DefaultAvatar.js";
import { HistoryList } from "../components/HistoryList.js";
import { Section } from "../components/Section.js";
import { FrameAction, SectionFrame } from "../components/SectionFrame.js";
import { MessageBoardSection } from "../components/MessageBoard.js";
import { NotificationBell } from "../components/Notifications.js";
import { TabPage } from "../components/Layouts.js";
import { TabPageHeader } from "../components/TabPageHeader.js";
import { SkeletonRows } from "../components/States.js";
import { errorMessage } from "../lib/api.js";
import { useBookMembers, useBooks, useInviteToBook, useLeaveBook, useLedger } from "../lib/queries.js";

/**
 * **账本 / 协作 —— 第四个主 Tab，和明细、分析、账户同级。**
 *
 * ⚠️ **The owner's framing is "一个账本相当于一个群组"**, and this page is where that shows. The
 * headings below are his, verbatim:
 *
 * > *"单人账本：底部导航和页面标题显示「账本」……内容从上到下：当前账本信息、编辑记录、邀请成员。"*
 * >
 * > *"多人账本：底部导航和页面标题显示「协作」……内容从上到下：顶部两张并排卡片（当前账本／成员）、
 * >  编辑记录、留言。"*
 *
 * ⚠️ **One page, two emphases — never two pages.** *"不创建两套完全独立的一级页面"*, and the same
 * instruction governs the bottom bar: **the label changes with the member count and the screen does
 * not.** A second route would let the two drift, and the reader would have two places to look for
 * one thing.
 *
 * ⚠️ **The frame is `TabPage`**, which is what `StatsPage` and `MePage` use: no back arrow, dynamic
 * viewport height, the middle region scrolls, and the bottom bar is a flex sibling rather than
 * something pinned over the content. **A main tab is a place you switch to, not one you come back
 * from.**
 *
 * ⚠️ **The green header, the `px-6` rhythm and the `rounded-card` blocks are the same pieces
 * `StatsPage` uses**, because the owner asked for one design system rather than a new one:
 * *"不要为了统一而把页面重新设计成与其他模块完全不同的新风格."*
 */
export function LedgerPage(): React.JSX.Element {
  const navigate = useNavigate();
  const ledger = useLedger();
  const books = useBooks();
  const members = useBookMembers();

  const memberCount = ledger.data?.book.memberCount ?? 1;
  const shared = memberCount >= 2;
  const stats = ledger.data?.stats;

  /* ⚠️ The list this page shows, and only the first few of it — see `MemberSummaryCard`. */
  const memberList = members.data?.members ?? [];

  return (
    <TabPage
      active="/ledger"
      onNavigate={(to) => {
        navigate(to);
      }}
    >
      {/**
        * ⚠️ **The title is the tab's own name**, so the screen and the bar agree: 账本 alone, 协作
        * with others. The owner's rule is that these are **the same page with a different emphasis**,
        * and the header saying the same word as the bar is the cheapest way to keep that true.
        *
        * ⚠️ **The bell lives here, in the header, as the owner specified**: *"在账本／协作一级页面
        * 绿色顶部区域右上角直接提供通知铃铛"* — and *"不论单人还是多人状态，都显示同一位置的通知入口."*
        * It is **outside the `shared` branch on purpose**: an invitation arrives whether or not this
        * ledger has two members, and a bell that only appeared in one state would be invisible
        * exactly when the first invitation is waiting.
        */}
      {/**
        * ⚠️ **The green heading area is `TabPageHeader`, shared with 分析** (1.10.10). The owner asked
        * for the two screens to be aligned *by construction*: *"尽可能复用相同的标题区布局规则或共享样式，
        * 保证以后修改时不会再次出现差异."*
        *
        * ⚠️ **The bell rides in the `action` slot, and the slot is the whole point.** The owner kept the
        * two ideas apart: *"如果账本／协作页顶部有通知铃铛等独有操作，应予保留；分析页不需要为了统一而增加
        * 相同功能."* So the **title block is the shared rule** and the right-hand side is per page.
        *
        * ⚠️ **The bell is outside the `shared` branch on purpose**: an invitation arrives whether or not
        * this ledger has two members, and a bell that appeared in only one state would be invisible
        * exactly when the first invitation is waiting.
        *
        * ⚠️ **The subtitle no longer waits for `ledger.isSuccess`.** It used to, which made this header
        * **one line shorter while loading and then jump** — and would have made it disagree with 分析
        * during exactly the moment a reader switching tabs sees both. **The words are static; a height
        * that depends on a request is a layout that moves.**
        */}
      <TabPageHeader
        title={shared ? "协作" : "账本"}
        subtitle={shared ? "与成员共同记账。" : "当前仅你一位成员。"}
        action={<NotificationBell showHeading={false} />}
      />

      {ledger.isPending ? (
        <section className="px-6 pt-6">
          <SkeletonRows rows={3} />
        </section>
      ) : null}

      {ledger.isSuccess ? (
        <>
          {/**
            * ⚠️ **First layer, and its shape is the owner's split.** Shared ledgers get **two cards
            * side by side** — 当前账本 and 成员 — and a lone ledger gets one card carrying the same
            * facts plus the way out to the ledger space.
            *
            * ⚠️ **The two cards must stay the same height.** His instruction: *"两张卡片应保持一致的高度
            * 与布局节奏。较长的账本名称、较多的成员数量和窄屏幕不应导致文字溢出或布局错乱."* The grid
            * gives them the same row; `h-full` and `min-h-0` with `truncate`/`line-clamp` keep a long
            * name or a crowd from changing that.
            */}
          {shared ? (
            <section className="grid grid-cols-2 items-stretch gap-3 px-6 pt-6">
              <CurrentBookCard
                name={ledger.data.book.name}
                bookNumber={ledger.data.book.bookNumber}
                bookCount={books.isSuccess ? books.data.books.length : null}
              />
              <MemberSummaryCard
                members={memberList}
                memberCount={memberCount}
                loading={members.isPending}
              />
            </section>
          ) : (
            <section className="px-6 pt-6">
              <SoloBookCard
                name={ledger.data.book.name}
                bookNumber={ledger.data.book.bookNumber}
                bookCount={books.isSuccess ? books.data.books.length : null}
              />
            </section>
          )}

          {/**
            * ⚠️ **编辑记录 —— 一个总外框，里面直接排条目（1.10.07）.**
            *
            * The owner's §4.3: the heading and the 查看全部 › link sit **above and outside** the
            * frame, and the frame's inside holds the records themselves with a hairline between
            * them — *"不出现'外框里面再套一个独立记录卡片'的结构."*
            *
            * ⚠️ **`embedded` is what removes the second card.** Before this, `Section` drew a card and
            * `HistoryList` drew another one inside it, so the reader looked through two borders at
            * two rows — which is the *"盒子套盒子"* the owner is asking to remove.
            */}
          {/**
            * ⚠️ **正式功能区标题，试验规格（16px/600）。** 这是所有者点名的两处之一。
            * ⚠️ **`titleClassName` 没有写** —— 走共享组件的默认值 `section-title`，
            * 所以它和「留言」由**同一个来源**决定，不可能是两个值。
            */}
          <SectionFrame
            title="编辑记录"
            action={<FrameAction to="/ledger/history">查看全部 ›</FrameAction>}
          >
            <HistoryList
              limit={2}
              embedded
              emptyHint="这本账还没有改动记录。改动记录从这个功能上线之后开始，之前的操作不会补记。"
            />
          </SectionFrame>

          {/**
            * ⚠️ **Third layer in the shared state: 留言.**
            *
            * ⚠️ **Not merged with 编辑记录 and not behind a Tab**, because the owner ruled both out:
            * *"不与编辑记录合并成一个动态流，也不使用 Tab 切换."* They answer different questions —
            * one is a record of what changed, the other is people talking — and a combined feed would
            * make "who said this" and "who changed this" look like the same kind of event.
            *
            * ⚠️ **`MessageBoardSection` owns the heading row too**, because 新消息 N 条 has to be read
            * before the board marks itself seen — see the note on that component.
            */}
          {shared ? <MessageBoardSection bookId={ledger.data.book.id} /> : null}

          {/**
            * ⚠️ **Last layer in the lone state: 邀请成员, as a local operation rather than a doorway.**
            *
            * The owner removed the detour himself — *"不再通过「邀请新成员 → 去邀请 → 协作者」这一冗长路径"*
            * and *"即使账本只有一名成员，也能直接搜索其他用户并邀请加入"* — and the 补充 spec puts this
            * in his third container category: *"一级页面内的局部操作区域……直接开放式结构"* and
            * *"单人状态下的'邀请成员'属于可直接操作模块……不要过度盒子套盒子."*
            *
            * ⚠️ **So it is `bare`:** a heading, one line of explanation, one input and one button.
            * **No frame** — the input already has its own edge, and wrapping it would be a box around
            * a box. `/ledger/invite` still exists for the fuller flow (role choice, member list).
            *
            * ⚠️ **In the shared state the invitation lives inside 成员管理 instead** — the owner put it
            * there: *"点击进入当前账本的成员管理。成员管理内可以查看成员、权限以及邀请新成员."*
            */}
          {shared ? null : (
            /**
              * ⚠️ **推广后走默认规格（16px/600）。** 所有者 2026-10-13 批准全站推广，
              * 并确认这一层也属于正式功能区标题。
              */
            <SectionFrame
              title="邀请成员"
              bare
            >
              <p className="mb-3 text-body-relaxed text-muted">
                这本账现在只有你一个人。输入对方的账号编号或用户名，他会收到一条邀请，
                接受之后才真正加入。
              </p>
              <QuickInvite bookName={ledger.data.book.name} />
            </SectionFrame>
          )}

          {/**
            * ⚠️ **Fourth layer: the details, previewed and one tap away.** The owner asked for exactly
            * this split: *"诸如完整账本编号、创建时间、空间占用、全部编辑历史、详细成员权限等内容，
            * 可在适当的位置简洁预览，再通过点击进入二级页面查看。不要为了展示所有数据而破坏主页面
            * 的简洁程度."*
            */}
          {stats === undefined ? null : (
            /**
             * ⚠️ **推广后走默认规格（16px/600）。** 与「编辑记录」「留言」同一层——
             * 它同样是页面上的一个整块内容区。
             */
            <Section
              title="账本信息"
              action={{ to: "/ledger/info", label: "详情" }}
            >
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <Fact label="创建于" value={stats.createdAt.slice(0, 10)} />
                <Fact label="账目" value={`${String(stats.transactionCount)} 笔`} />
                <Fact label="成员" value={`${String(memberCount)} 人`} />
                <Fact
                  label="占用空间"
                  /**
                   * ⚠️ **"约" stays.** An estimate shown beside three exact figures is read as exact,
                   * and somebody will eventually reconcile against it — see `estimateBytes`.
                   */
                  value={`约 ${formatBytes(estimateBytes(stats.transactionCount, stats.eventCount))}`}
                />
              </dl>
            </Section>
          )}

          <LeaveBookSection bookId={ledger.data.book.id} />
        </>
      ) : null}
    </TabPage>
  );
}

/**
 * **邀请成员，直接在这个页面上做完（单人状态）.**
 *
 * ⚠️ **It used to be a button that went to `/ledger/invite`** — which was already one step better
 * than the old 邀请新成员 → 去邀请 → 协作者 detour, but still a page for one field and one press.
 * The 补充 spec puts this module in the third container category — *"一级页面内的局部操作区域"* —
 * and says outright that *"单人状态下的'邀请成员'属于可直接操作模块."* **A local operation belongs
 * where the person already is.**
 *
 * ⚠️ **The full flow has not gone anywhere.** `/ledger/invite` still exists and is still where the
 * **role** is chosen, an outstanding invitation is shown, and the member list is. The link below
 * says so rather than hiding it — **a shortcut that removed the careful path would be a worse
 * trade than the step it saved.**
 *
 * ⚠️ **The server refuses anything this cannot express**, and the permission is unchanged: sending
 * an invitation is a *write*, so a viewer is refused by `requireBookForWrite` regardless of what
 * this page draws.
 */
function QuickInvite({ bookName }: { readonly bookName: string }): React.JSX.Element {
  const invite = useInviteToBook();

  const [query, setQuery] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const value = query.trim();
  const canSend = value !== "" && invite.isPending === false;

  function send(): void {
    if (!canSend) return;

    setError(null);
    setSent(false);

    /**
     * ⚠️ **Eight digits is a number, anything else is a username** — the same rule the invite screen
     * uses, and the same rule the server validates. **One field, no mode switch**: the user should
     * not have to classify what they typed.
     */
    const target = /^[0-9]{8}$/.test(value) ? { accountNumber: value } : { username: value };

    void invite
      .mutateAsync({ ...target, role: "editor" })
      .then(() => {
        setSent(true);
        setQuery("");
      })
      .catch((caught: unknown) => {
        setError(errorMessage(caught));
      });
  }

  return (
    <div className="flex flex-col gap-2.5">
      {error === null ? null : (
        <p role="alert" className="rounded-field bg-danger-soft px-4 py-3 text-body text-danger">
          {error}
        </p>
      )}

      {sent ? (
        <p role="status" className="rounded-field bg-brand-soft px-4 py-3 text-body text-brand-dark">
          邀请已经发出。他会在通知里看到，接受之后就成为「{bookName}」的成员。
        </p>
      ) : null}

      {/**
        * ⚠️ **Input left, button right, and the input takes the width** — the same priority as the
        * message box: `flex-1` against `shrink-0`, so a narrow phone shrinks nothing that matters.
        */}
      <div className="flex items-center gap-2">
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") send();
          }}
          placeholder="账号编号或用户名"
          aria-label="要邀请谁"
          autoComplete="off"
          className="min-h-11 flex-1 rounded-field border border-line bg-surface px-3.5 py-2.5 text-body text-ink transition outline-none placeholder:text-muted/80 focus:border-brand focus:ring-4 focus:ring-brand-soft"
        />

        <button
          type="button"
          disabled={!canSend}
          onClick={send}
          className="shrink-0 rounded-field bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-dark disabled:opacity-45"
        >
          {invite.isPending ? "发送中…" : "邀请"}
        </button>
      </div>

      <Link to="/ledger/invite" className="text-helper text-brand transition hover:text-brand-dark">
        选择对方的权限，或查看已发出的邀请 ›
      </Link>
    </div>
  );
}

/**
 * **当前账本 —— the shared state's left card.**
 *
 * ⚠️ **Two separate tap targets inside one card, and that is the owner's requirement**:
 * *"将「切换账本」整合在卡片内，但应与「查看账本详情」形成清楚的独立点击目标."* So the name is a
 * link to the ledger's details and 切换账本 is its own control — **nested links are invalid HTML and
 * would make the two indistinguishable to a screen reader**, which is why they are siblings here
 * rather than one inside the other.
 */
function CurrentBookCard({
  name,
  bookNumber,
  bookCount,
}: {
  readonly name: string;
  readonly bookNumber: string | null;
  readonly bookCount: number | null;
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col justify-between gap-3 rounded-card border border-line bg-surface p-4">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-helper text-muted">当前账本</span>
        <Link
          to="/ledger/info"
          className="truncate text-base font-medium text-ink transition hover:text-brand-dark"
        >
          {name}
        </Link>
        <span className="truncate font-mono text-helper text-muted">
          {bookNumber ?? "（未分配编号）"}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <Link to="/ledger/info" className="text-helper text-brand transition hover:text-brand-dark">
          账本详情 ›
        </Link>
        <Link to="/start" className="text-helper text-brand transition hover:text-brand-dark">
          切换账本{bookCount === null ? "" : `（共 ${String(bookCount)} 本）`} ›
        </Link>
      </div>
    </div>
  );
}

/**
 * **成员 —— the shared state's right card: a count and a glimpse, not the list.**
 *
 * ⚠️ **The controls live on the members page**, and this card is the way in — the owner:
 * *"点击后进入当前账本的成员管理。成员管理内可以查看成员、权限以及邀请新成员."* Showing roles and
 * remove buttons here would make the main tab the management screen, which is the layer split he
 * asked for in the same paragraph.
 *
 * ⚠️ **Two or three faces, then a number.** A ledger with twenty members must not push this card
 * taller than the one beside it, so the extras are counted rather than listed.
 */
function MemberSummaryCard({
  members,
  memberCount,
  loading,
}: {
  readonly members: readonly { readonly userId: string; readonly displayName: string }[];
  readonly memberCount: number;
  readonly loading: boolean;
}): React.JSX.Element {
  /** ⚠️ Three at most, and the remainder is arithmetic — see the note above about equal heights. */
  const faces = members.slice(0, 3);
  const extra = Math.max(0, memberCount - faces.length);

  return (
    <Link
      to="/ledger/members"
      className="flex h-full min-h-0 flex-col justify-between gap-3 rounded-card border border-line bg-surface p-4 transition hover:border-brand/40"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-helper text-muted">成员</span>
        <span className="text-base font-medium text-ink">
          {loading ? "…" : `${String(memberCount)} 人`}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        {faces.length === 0 ? (
          /** ⚠️ A placeholder rather than an empty row, so the card keeps its shape while loading. */
          <span className="h-8" aria-hidden="true" />
        ) : (
          <span className="flex items-center gap-1.5">
            {faces.map((member) => (
              <span
                key={member.userId}
                title={member.displayName}
                className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-line"
              >
                <DefaultAvatar className="size-8" />
              </span>
            ))}
            {extra > 0 ? <span className="text-helper text-muted">+{String(extra)}</span> : null}
          </span>
        )}

        <span className="text-helper text-brand">成员管理 ›</span>
      </div>
    </Link>
  );
}

/**
 * **当前账本信息 —— the lone state's single card.**
 *
 * ⚠️ **The owner's first item for a one-person ledger is "当前账本信息……账本名称、编号及部分基本信息"**,
 * with the switcher inside it — so this card carries the name, the number and the way out, and the
 * two tap targets are as separate as they are in the shared state.
 *
 * ⚠️ **It keeps the brand tint the old card had.** The tint is what makes it read as a way *between*
 * ledgers rather than another item *in* this one, which was the reason for it before this change.
 */
function SoloBookCard({
  name,
  bookNumber,
  bookCount,
}: {
  readonly name: string;
  readonly bookNumber: string | null;
  readonly bookCount: number | null;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 rounded-card border border-brand/30 bg-brand-soft/50 p-5">
      <div className="flex flex-col gap-0.5">
        <span className="text-helper text-muted">当前账本</span>
        <Link
          to="/ledger/info"
          className="truncate text-base font-medium text-brand-dark transition hover:underline"
        >
          {name}
        </Link>
        <span className="truncate font-mono text-helper text-muted">
          {bookNumber ?? "（未分配编号）"}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Link to="/start" className="text-helper text-brand-dark transition hover:underline">
          切换账本{bookCount === null ? "" : `（共 ${String(bookCount)} 本）`} ›
        </Link>
        <Link to="/ledger/info" className="text-helper text-brand-dark transition hover:underline">
          账本详情 ›
        </Link>
      </div>
    </div>
  );
}

/** One label-and-value pair in the details preview. */
function Fact({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-helper text-muted">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

/**
 * **退出这本账 —— 只对「不是创建者」的人显示。**
 *
 * ⚠️ **The owner keeps two meanings apart**, and this is the second of them: *"不是同一回事"* (Q5).
 * **弃置** is *"整本弃置"* — it sets the ledger aside for everybody, and **only its creator may do
 * it**. **退出** is *"我不想再显示这本账"* — one person stepping out of somebody else's ledger.
 *
 * ⚠️ **So the creator sees no button here**, and the server says the same (`creator_cannot_leave`):
 * **removing the last writer would leave a ledger nobody can edit, invite into or dispose of**, and
 * no screen could undo it. Their route is 弃置, which lives on 我的账本.
 *
 * ⚠️ **It sits at the very bottom, after the information.** A destructive action placed above the
 * content is one people reach by scrolling past it.
 *
 * ⚠️ **`bookId` is passed in rather than derived.** My first version wrote a helper that returned
 * `member.userId` under the name `ledgerIdOf` — **which would have asked the server to make the user
 * leave a ledger whose id happened to equal their own user id.** It is a type error waiting to be a
 * runtime one, and the fix is to take the ledger from the ledger.
 */
function LeaveBookSection({ bookId }: { readonly bookId: string }): React.JSX.Element | null {
  const { user } = useAuth();
  const members = useBookMembers();
  const leave = useLeaveBook();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const me = members.data?.members.find((member) => member.userId === user?.id) ?? null;

  /** ⚠️ Nothing at all while the answer is unknown — a button that appears then vanishes is worse. */
  if (me === null || me.isCreator) return null;

  return (
    /**
      * ⚠️ **推广后走默认规格（16px/600）。**
      */
    <Section title="退出这本账">
      {error === null ? null : (
        <p role="alert" className="mb-3 rounded-field bg-danger-soft px-4 py-3 text-body text-danger">
          {error}
        </p>
      )}

      <p className="text-body-relaxed text-muted">
        退出之后这本账不再出现在你的列表里，你也就看不到它的账目了。
        你记过的账目会留下，历史记录里也会留下这一条。
      </p>

      {confirming ? (
        <div className="mt-3 flex gap-3">
          <button
            type="button"
            disabled={leave.isPending}
            onClick={() => {
              setError(null);
              void leave
                .mutateAsync(bookId)
                .then(() => {
                  /**
                   * ⚠️ **A reload, for the same reason entering a ledger is one**: leaving changes
                   * which ledger every later request addresses and which slice of the offline copy is
                   * read. **A screen showing this ledger's header over another's entries is the
                   * failure the isolation exists to prevent**, and a reload cannot be half-done.
                   */
                  window.location.assign("/");
                })
                .catch((caught: unknown) => {
                  setError(errorMessage(caught));
                  setConfirming(false);
                });
            }}
            className="rounded-field bg-danger px-4 py-2 text-sm text-white transition hover:bg-danger-dark disabled:opacity-45"
          >
            {leave.isPending ? "正在退出……" : "确认退出"}
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
            }}
            className="rounded-field bg-canvas px-4 py-2 text-body text-muted transition hover:text-ink"
          >
            取消
          </button>
        </div>
      ) : (
        /**
         * ⚠️ **Red, at the owner's instruction (2026-10-13): *"把多人账目中的退出这笔帐按钮改成红的."***
         *
         * ⚠️ **It used to be a quiet grey button that only turned red on hover** — and that was
         * defensible (the confirmation step is the real gate, and a red button invites the tap it is
         * warning about). **The owner overruled it, and his reason is the better one: a grey button
         * in a section titled 退出这本账 does not look like the thing it is.** The colour has to
         * match the act, or the warning only arrives after the reader has already decided.
         *
         * ⚠️ **Nothing about the safety changed**: this still only *asks*, and `ConfirmDialog`-style
         * confirm/cancel below is still the step that leaves. **The colour is the signpost, not the
         * guard** — and the server refuses a creator regardless of what any of this looks like.
         */
        <button
          type="button"
          onClick={() => {
            setConfirming(true);
          }}
          className="mt-3 rounded-field bg-danger px-4 py-2 text-sm text-white transition hover:bg-danger-dark"
        >
          退出这本账
        </button>
      )}
    </Section>
  );
}

/**
 * A rough size for one ledger's rows.
 *
 * ⚠️ **Deliberately an estimate, and the constants are deliberately round.** PostgreSQL keeps table
 * bytes per table, not per owning ledger, so an exact answer means measuring each row's payload —
 * **real work for a figure nobody makes a decision with.**
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
