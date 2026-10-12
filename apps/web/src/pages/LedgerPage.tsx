import { Link, useNavigate } from "react-router";

import { HistoryList } from "../components/HistoryList.js";
import { MemberList } from "../components/MemberList.js";
import { Section } from "../components/Section.js";
import { MessageBoard } from "../components/MessageBoard.js";
import { TabPage } from "../components/Layouts.js";
import { SkeletonRows } from "../components/States.js";
import { useBooks, useLedger } from "../lib/queries.js";

/**
 * **账本 / 协作 —— 第四个主 Tab，和明细、分析、账户同级。**
 *
 * ⚠️ **This page used to be built on `InnerPage`, and that was the whole bug.** `InnerPage` is the
 * frame for screens *reached from* a tab — it has a back arrow, no bottom bar, and a white
 * background. Using it here made a **top-level destination look like a detail page somebody had
 * navigated into**, which is exactly what the owner reported:
 *
 * > *"你把一级 Tab 页面做成了二级详情页……它看上去更像「账目详情」「设置详情」「拍照上传」一类从其他
 * >  页面进入的子页面。这是我希望纠正的重点。"*
 *
 * ⚠️ **So the frame is `TabPage`**, which is what `StatsPage` and `MePage` use: dynamic viewport
 * height, the middle region scrolls, and **the bottom navigation is a flex sibling of the content
 * rather than something pinned over it.** There is no back arrow here, and there must not be —
 * **a main tab is a place you switch to, not a place you come back from.**
 *
 * ⚠️ **The green header, the `px-6` rhythm, the `rounded-card` cards and the `Section` shape are
 * copied from `StatsPage` rather than invented**, because the owner asked for one design system:
 * *"不要只简单地给新页面加一个绿色标题条，而是让它整体看上去确实与另外三个主 Tab 属于同一套
 * 设计系统."* The pieces below are the same pieces.
 *
 * ⚠️ **The page answers three questions in order** — *"这是什么账本？谁在使用它？这本账最近发生了什么？"*
 * — so the sections run: which ledger → who is in it → what happened. **The order is the answer, not
 * a layout preference.**
 */
export function LedgerPage(): React.JSX.Element {
  const navigate = useNavigate();
  const ledger = useLedger();
  const books = useBooks();

  const members = ledger.data?.book.memberCount ?? 1;
  const shared = members >= 2;
  const stats = ledger.data?.stats;

  return (
    <TabPage active="/ledger" onNavigate={(to) => { navigate(to); }}>
      {/**
        * ⚠️ **The brand header, identical in shape to 分析's.** Title, one line of explanation, and
        * the colour doing the work of saying "you are at the top of a section" — **the thing the old
        * white page with a back arrow could not say.**
        *
        * ⚠️ **The title is the tab's own name**, so the screen and the bar agree: 账本 alone, 协作
        * with others. The owner's rule is that these are **the same page with a different emphasis**,
        * and the header saying the same word as the bar is the cheapest way to keep that true.
        */}
      <header className="bg-brand px-6 pt-8 pb-6 text-white">
        <h1 className="text-xl font-semibold tracking-tight">{shared ? "协作" : "账本"}</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-white/80">
          {shared ? "这本账由几个人一起记。" : "这本账目前只有你一个人在用。"}
        </p>
      </header>

      {ledger.isPending ? (
        <section className="px-6 pt-6">
          <SkeletonRows rows={3} />
        </section>
      ) : null}

      {ledger.isSuccess ? (
        <>
          {/**
            * ⚠️ **Second layer: which ledger, and the way out to the ledger space.** The owner was
            * specific that the switcher must not be buried: *"「前往账本空间／切换账本」必须是清楚、
            * 容易找到的正式入口，而不能藏在一堆设置选项里."* So it is **its own tinted card at the
            * top of the content**, not a row in a settings list.
            *
            * ⚠️ **The card carries a brand tint** rather than the plain surface colour, which is how
            * it reads as a way *between* ledgers instead of another item *in* this one.
            */}
          <section className="px-6 pt-6">
            <Link
              to="/start"
              className="flex items-center justify-between gap-4 rounded-card border border-brand/30 bg-brand-soft/50 px-5 py-4 transition hover:bg-brand-soft"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-base font-medium text-brand-dark">
                  {ledger.data.book.name}
                </span>
                <span className="font-mono text-xs text-muted">
                  {ledger.data.book.bookNumber ?? "（未分配编号）"}
                  {books.isSuccess ? ` · 共 ${String(books.data.books.length)} 本账` : ""}
                </span>
              </span>

              <span className="flex shrink-0 items-center gap-1 text-xs text-brand-dark">
                切换账本
                <span aria-hidden="true" className="text-base leading-none">
                  ›
                </span>
              </span>
            </Link>
          </section>

          {/**
            * ⚠️ **Third layer: the main functional content, and what it emphasises depends on the
            * member count** — *"个人账本重点展示最近编辑历史、账本信息及邀请协作者入口。共享账本
            * 重点展示成员信息、管理与邀请入口、留言或群聊入口，以及最近编辑历史."*
            *
            * ⚠️ **Members come first when shared and are absent when alone** — the same components,
            * ordered by what the reader came for. **That reordering is the "两种侧重" the owner asked
            * for**; making a second page for the shared case is what he explicitly ruled out.
            */}
          {shared ? (
            <Section title="成员" action={{ to: "/ledger/members", label: "管理" }}>
              <MemberList compact />
            </Section>
          ) : null}

          <Section title="编辑历史" action={{ to: "/ledger/history", label: "查看全部" }}>
            <HistoryList
              limit={5}
              emptyHint="这本账还没有改动记录。改动记录从这个功能上线之后开始，之前的操作不会补记。"
            />
          </Section>

          {shared ? (
            <Section title="留言">
              <MessageBoard />
            </Section>
          ) : null}

          <Section title={shared ? "邀请" : "邀请协作者"}>
            {shared ? null : (
              <p className="mb-3 text-sm leading-relaxed text-muted">
                这本账现在只有你一个人。邀请别人加入之后，它就成为共享账本。
              </p>
            )}
            <Link
              to="/ledger/invite"
              className="inline-flex rounded-field bg-brand px-4 py-2.5 text-sm text-white transition hover:bg-brand-dark"
            >
              邀请新成员
            </Link>
          </Section>

          {/**
            * ⚠️ **Fourth layer: the details, previewed and one tap away.** The owner asked for exactly
            * this split: *"诸如完整账本编号、创建时间、空间占用、全部编辑历史、详细成员权限等内容，
            * 可在适当的位置简洁预览，再通过点击进入二级页面查看。不要为了展示所有数据而破坏主页面
            * 的简洁程度."*
            *
            * ⚠️ **So the preview is four short facts and everything else is behind the link.** The old
            * page printed all of them as a six-row definition list, which **is** a settings screen —
            * the diagnosis the owner gave.
            */}
          {stats === undefined ? null : (
            <Section title="账本信息" action={{ to: "/ledger/info", label: "详情" }}>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <Fact label="创建于" value={stats.createdAt.slice(0, 10)} />
                <Fact label="账目" value={`${String(stats.transactionCount)} 笔`} />
                <Fact label="成员" value={`${String(members)} 人`} />
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
        </>
      ) : null}
    </TabPage>
  );
}


/** One label/value pair in the info preview. */
function Fact({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
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
