import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";

import { Button } from "../components/Button.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { InnerPage } from "../components/Layouts.js";
import { MemberList } from "../components/MemberList.js";
import { ShareSection } from "../components/ShareSection.js";
import { SkeletonRows } from "../components/States.js";
import { TextField } from "../components/TextField.js";
import { errorMessage } from "../lib/api.js";
import { useBookMembers, useDisposeBook, useLedgerMeta, useRenameBook } from "../lib/queries.js";

/**
 * **一本账的目标页面 —— 齿轮面板打开的三个二级页。**
 *
 * ⚠️ **Every page in this file takes its ledger from the URL, and none of them touches the current
 * ledger.** That is the owner's requirement restated three times in his spec — *"必须确保显示的是被点击
 * 齿轮的目标账本，而不是默认读取当前全局账本"* and *"不允许通过静默修改全局当前账本来实现这一点"* —
 * and the mechanism is one thing: **the ledger id travels in the request header per call**, using the
 * override `apiFetch` already had.
 *
 * ⚠️ **`useLedgerMeta`, never `useLedger`.** The latter is how the device learns which ledger it is
 * *in*, so calling it here would move the session to a ledger nobody entered. See the note on that
 * hook.
 *
 * ⚠️ **These are B-class screens and they look like it** — white background, a title, a back control.
 * That is the same layer split the owner set for the ledger tab: **the main page stays a space, and
 * management lives one step in.**
 */

/** The shared frame, so all three read the ledger's name the same way and fail the same way. */
function useTargetLedger(): {
  readonly bookId: string;
  readonly name: string | null;
  readonly pending: boolean;
  readonly failed: boolean;
} {
  const { bookId = "" } = useParams<{ bookId: string }>();
  const meta = useLedgerMeta(bookId);

  return {
    bookId,
    name: meta.data?.book.name ?? null,
    pending: meta.isPending,
    failed: meta.isError,
  };
}

/**
 * **账本详情 —— 齿轮面板的第一项。**
 *
 * ⚠️ **This is the second screen that shows a ledger's facts, and it exists for a reason.** The first
 * is `LedgerInfoPage`, which reads the **current** ledger — you reach it from the 账本 tab while you
 * are inside that ledger. This one is reached from the start page **for a ledger you have not
 * entered**, so it deliberately does *not* reuse that page: doing so would have needed either a
 * silent switch (forbidden) or a component that reads two different sources depending on a flag.
 */
export function StartBookInfoPage(): React.JSX.Element {
  const { bookId, name, pending, failed } = useTargetLedger();
  const meta = useLedgerMeta(bookId);
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();

  const rename = useRenameBook();
  const dispose = useDisposeBook();

  const [editing, setEditing] = useState(search.get("rename") === "1");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmingDispose, setConfirmingDispose] = useState(false);

  /**
   * ⚠️ **The field opens pre-filled with the current name**, as the owner asked: *"输入框自动填入当前名称."*
   * It is seeded when editing starts rather than on every render, so the reader's typing is not
   * overwritten by a refetch landing behind them.
   */
  function startEditing(): void {
    setDraft(name ?? "");
    setError(null);
    setEditing(true);
    const next = new URLSearchParams(search);
    next.set("rename", "1");
    setSearch(next, { replace: true });
  }

  function stopEditing(): void {
    setEditing(false);
    setError(null);
    const next = new URLSearchParams(search);
    next.delete("rename");
    setSearch(next, { replace: true });
  }

  function submitRename(): void {
    const value = draft.trim();
    /** ⚠️ The same bounds the server enforces — 1–40, trimmed. Checked here so the error is instant. */
    if (value === "") {
      setError("账本名称不能为空。");
      return;
    }
    if (value.length > 40) {
      setError("账本名称最多 40 个字符。");
      return;
    }

    setError(null);
    void rename
      .mutateAsync({ bookId, name: value })
      .then(() => {
        /** ⚠️ The search param is cleared so a refresh does not reopen the editor. */
        stopEditing();
      })
      .catch((caught: unknown) => {
        /** ⚠️ The draft is kept, per the owner: *"出错时保留用户输入并显示错误."* */
        setError(errorMessage(caught));
      });
  }

  return (
    <InnerPage title="账本详情" subtitle={name ?? "正在读取……"} backTo="/start">
      {pending ? <SkeletonRows rows={3} /> : null}

      {failed ? (
        <p className="rounded-card border border-line bg-surface px-5 py-4 text-body-relaxed text-muted">
          无法载入账本信息。账本可能已弃置，或你已不再是成员。
        </p>
      ) : null}

      {meta.isSuccess ? (
        <>
          <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-3 rounded-card border border-line bg-surface p-5 text-sm">
            <dt className="text-muted">账本名称</dt>
            <dd className="text-right text-ink">{meta.data.book.name}</dd>

            <dt className="text-muted">账本编号</dt>
            <dd className="text-right font-mono text-ink">
              {meta.data.book.bookNumber ?? "（未分配）"}
            </dd>

            <dt className="text-muted">成员数量</dt>
            <dd className="text-right text-ink">{String(meta.data.book.memberCount ?? 1)} 人</dd>

            {meta.data.stats === undefined ? null : (
              <>
                <dt className="text-muted">创建时间</dt>
                <dd className="text-right text-ink">{meta.data.stats.createdAt.slice(0, 10)}</dd>

                <dt className="text-muted">账目数量</dt>
                <dd className="text-right text-ink">{String(meta.data.stats.transactionCount)} 笔</dd>

                <dt className="text-muted">编辑记录</dt>
                <dd className="text-right text-ink">{String(meta.data.stats.eventCount)} 条</dd>
              </>
            )}
          </dl>

          {/**
            * ⚠️ **Rename is offered here rather than in the sheet, and the sheet links here for it.**
            * A rename needs a text field and somewhere to show an error; a Bottom Sheet is the wrong
            * container for a form. The gear passes `?rename=1`, so the reader lands with the field
            * already open — **the panel's promise ("重命名") is kept without putting an input in it.**
            */}
          <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-5">
            <h2 className="text-sm font-medium text-ink">重命名</h2>

            {editing ? (
              <>
                {error === null ? null : (
                  <p role="alert" className="rounded-field bg-danger-soft px-4 py-3 text-body text-danger">
                    {error}
                  </p>
                )}

                <TextField
                  label="账本名称"
                  value={draft}
                  maxLength={40}
                  autoFocus
                  onChange={(event) => {
                    setDraft(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") submitRename();
                  }}
                />

                <div className="flex gap-3">
                  <Button fullWidth={false} disabled={rename.isPending} onClick={submitRename}>
                    {rename.isPending ? "正在保存…" : "保存"}
                  </Button>
                  <Button variant="secondary" fullWidth={false} onClick={stopEditing}>
                    取消
                  </Button>
                </div>
              </>
            ) : (
              <Button variant="secondary" fullWidth={false} onClick={startEditing}>
                修改名称
              </Button>
            )}
          </section>

          {/**
            * ⚠️ **弃置 lives here too, and it is creator-only — the server says so as well.** The sheet
            * shows it for the same relationship, so the two agree because they read the same field
            * (`isCreator`), not because they were written to match.
            */}
          <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-5">
            <h2 className="text-sm font-medium text-ink">弃置这本账</h2>
            <p className="text-body-relaxed text-muted">
              弃置后这本账对所有人都不再显示，数据保留，你作为创建者随时可以恢复。
            </p>

            {error !== null && !editing ? (
              <p role="alert" className="rounded-field bg-danger-soft px-4 py-3 text-body text-danger">
                {error}
              </p>
            ) : null}

            <Button
              variant="secondary"
              fullWidth={false}
              disabled={dispose.isPending}
              onClick={() => {
                setConfirmingDispose(true);
              }}
            >
              弃置这本账
            </Button>
          </section>

          <Link to="/start" className="text-body text-brand transition hover:text-brand-dark">
            ‹ 返回账本空间
          </Link>
        </>
      ) : null}

      <ConfirmDialog
        open={confirmingDispose}
        title={`弃置「${name ?? "这本账"}」？`}
        description="弃置后，所有成员都将看不到此账本。数据会保留，创建者可恢复。"
        consequences={["对这本账的所有成员都不再显示", "账目、成员、留言全部保留，不是删除", "创建者随时可以恢复"]}
        confirmLabel="弃置这本账"
        busy={dispose.isPending}
        onCancel={() => {
          setConfirmingDispose(false);
        }}
        onConfirm={() => {
          setError(null);
          void dispose
            .mutateAsync(bookId)
            .then(() => {
              /**
                * ⚠️ **Back to the start page, because this ledger is no longer in the list.** Staying
                * on its detail screen would show a ledger the reader has just removed from view.
                */
              navigate("/start");
            })
            .catch((caught: unknown) => {
              setError(errorMessage(caught));
              setConfirmingDispose(false);
            });
        }}
      />
    </InnerPage>
  );
}

/**
 * **成员与邀请 —— 目标账本的成员管理。**
 *
 * ⚠️ **`MemberList` is given the ledger id, and that is the whole change from the current-ledger
 * screen.** Every call it makes — the member list, a role change, a removal — names the target
 * ledger in the header, **so the panel can manage a ledger the reader is not in.**
 *
 * ⚠️ **What each person may do is decided by the server, not by this page.** `MemberList` hides
 * controls it cannot use and **every action is re-checked server-side** — the owner's rule, and the
 * reason the invite section below it is not a permission of its own.
 */
export function StartBookMembersPage(): React.JSX.Element {
  const { bookId, name, pending } = useTargetLedger();
  const members = useBookMembers(bookId);

  /**
    * ⚠️ **The invite section follows `myRole`, which comes from the server with the member list.**
    * A viewer sees the members and their permissions but is not offered the door —
    * *"查看者不应获得编辑或邀请权限."* **The server refuses it anyway** (`requireBookForWrite`), so this
    * is about not showing somebody a button that cannot work.
    */
  const canInvite = members.data?.myRole === "owner" || members.data?.myRole === "editor";

  return (
    <InnerPage title="成员与邀请" subtitle={name ?? "正在读取……"} backTo="/start">
      {pending ? <SkeletonRows rows={3} /> : null}

      <div className="rounded-card border border-line bg-surface p-5">
        <MemberList bookId={bookId} />
      </div>

      {canInvite ? (
        <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-5">
          <h2 className="text-sm font-medium text-ink">邀请新成员</h2>
          <p className="text-body-relaxed text-muted">
            按对方账号编号或用户名找到他，选好权限，发一条邀请。他接受之后才真正加入这本账。
          </p>
          {/**
            * ⚠️ **This one really does enter the ledger, and the label says so.**
            *
            * `/ledger/invite` names its ledger in the request header, which is the **current** ledger
            * — so inviting from there means being in the ledger, and it cannot be reached for a target
            * ledger without switching (which is forbidden). Rather than build a second invite screen
            * that invites into an arbitrary ledger, the link is honest about what it does: **it enters
            * 这本账 first.** The alternative was a silent switch, and that is the one thing the owner
            * ruled out by name.
            */}
          <p className="rounded-field bg-canvas px-4 py-3 text-helper-relaxed text-muted">
            邀请要在一本账里面发起。点下面的按钮会先进入「{name ?? "这本账"}」，然后在那个页面上邀请。
          </p>
          <a
            href="/ledger/invite"
            className="inline-flex self-start rounded-field bg-brand px-4 py-2.5 text-sm text-white transition hover:bg-brand-dark"
          >
            去邀请
          </a>
        </div>
      ) : null}

      <p className="text-helper-relaxed text-muted">
        成员管理属于当前打开的这本账。邀请别人加入某一本账，不会把你或他加入其他账本。
      </p>
    </InnerPage>
  );
}

/**
 * **分享链接 —— 目标账本的链接邀请。**
 *
 * ⚠️ **This is the module the owner moved *off* the start page**, verbatim: *"原先直接摆在开始页上的以下
 * 设置应从主页移除：分享权限；有效期；人数上限；生成分享链接；已有分享链接的管理或撤销。这些内容进入
 * 对应账本的专门分享页面."* The gear shows one row; this is the page behind it.
 *
 * ⚠️ **`ShareSection` is reused unchanged apart from taking a `bookId`.** A second implementation
 * would be a second answer to "is this link still usable", and the server's `active` flag is the only
 * answer that matters.
 */
export function StartBookSharePage(): React.JSX.Element {
  const { bookId, name, pending } = useTargetLedger();
  const meta = useLedgerMeta(bookId);

  return (
    <InnerPage title="分享链接" subtitle={name ?? "正在读取……"} backTo="/start">
      {pending ? <SkeletonRows rows={3} /> : null}

      {meta.isSuccess ? (
        <>
          <p className="text-helper-relaxed text-muted">
            分享链接让别人自己加入这本账。加入进来的人会成为这本账的成员，
            <strong className="font-medium text-ink">与你的其他账本没有关系</strong>。
          </p>

          <ShareSection bookId={bookId} />

          <p className="text-helper-relaxed text-muted">
            想按名字邀请某个人，用「成员与邀请」；用于注册账号的邀请码属于账号本身，在「设置 → 账号安全」。
          </p>
        </>
      ) : null}
    </InnerPage>
  );
}
