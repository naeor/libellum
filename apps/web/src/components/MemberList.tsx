import { useState } from "react";

import { errorMessage } from "../lib/api.js";
import {
  useBookMembers,
  useChangeMemberRole,
  useRemoveMember,
  type BookMemberView,
} from "../lib/queries.js";

/**
 * **这本账的成员：谁在这里，他能做什么。**
 *
 * ⚠️ **Members of the ledger, not a contact list.** The owner drew the line twice:
 * *"这里的关系**始终是账本成员关系**"* and *"**成员管理必须明确属于当前账本。** 用户可能同时参与几本
 * 不同的共享账本，而每本账的成员都可能不同."*
 *
 * ⚠️ **The list comes from the server with no key of its own** — the request header names the
 * ledger, so there is nothing here that could show one ledger's members under another's name.
 *
 * ⚠️ **What the buttons do depends on `myRole`, and the server checks it again.** The screen hides
 * nothing it cannot do — hiding is how somebody concludes the app is broken — but every action here
 * is refused server-side too, because **the interface is a courtesy and the guard is the control.**
 */
export function MemberList(): React.JSX.Element {
  const members = useBookMembers();
  const changeRole = useChangeMemberRole();
  const removeMember = useRemoveMember();

  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<BookMemberView | null>(null);

  if (members.isPending) return <p className="text-sm text-muted">正在读取成员……</p>;
  if (members.isError) return <p className="text-sm text-muted">成员读取失败。</p>;

  const { members: list, myRole } = members.data;
  const canManage = myRole === "editor" || myRole === "owner";

  function run(userId: string, action: () => Promise<unknown>): void {
    setError(null);
    setBusyId(userId);
    void action()
      .catch((caught: unknown) => {
        setError(errorMessage(caught));
      })
      .finally(() => {
        setBusyId(null);
      });
  }

  return (
    <div className="flex flex-col gap-3">
      {error !== null ? (
        <p role="alert" className="rounded-field bg-danger-soft px-4 py-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <ul className="overflow-hidden rounded-card border border-line bg-surface">
        {list.map((member) => (
          <li key={member.userId} className="border-b border-line last:border-b-0">
            <MemberRow
              member={member}
              canManage={canManage}
              busy={busyId === member.userId}
              onChangeRole={(role) => {
                run(member.userId, () => changeRole.mutateAsync({ userId: member.userId, role }));
              }}
              onAskRemove={() => {
                setConfirmRemove(member);
              }}
            />
          </li>
        ))}
      </ul>

      {/**
        * ⚠️ **A viewer is told why there are no buttons.** The owner's rule is that a viewer sees
        * everything except editing — so they see the member list, and **the one sentence explaining
        * why nothing here is theirs to press** is what stops "the app is broken" from being the
        * conclusion.
        */}
      {canManage ? null : (
        <p className="text-xs leading-relaxed text-muted">
          你是这本账的查看者，可以看到成员，但不能修改权限或移除成员。
        </p>
      )}

      {confirmRemove === null ? null : (
        <RemoveConfirm
          member={confirmRemove}
          busy={busyId === confirmRemove.userId}
          onCancel={() => {
            setConfirmRemove(null);
          }}
          onConfirm={() => {
            const target = confirmRemove;
            setConfirmRemove(null);
            run(target.userId, () => removeMember.mutateAsync(target.userId));
          }}
        />
      )}
    </div>
  );
}

function MemberRow({
  member,
  canManage,
  busy,
  onChangeRole,
  onAskRemove,
}: {
  readonly member: BookMemberView;
  readonly canManage: boolean;
  readonly busy: boolean;
  readonly onChangeRole: (role: "editor" | "viewer") => void;
  readonly onAskRemove: () => void;
}): React.JSX.Element {
  const roleLabel = member.role === "viewer" ? "仅查看" : "可编辑";

  return (
    <div className="flex flex-col gap-2 px-5 py-4">
      <div className="flex items-center justify-between gap-4">
        <span className="flex flex-col gap-0.5">
          <span className="flex items-center gap-2 text-sm text-ink">
            {member.displayName}
            {member.isCreator ? (
              <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] text-brand-dark">
                创建者
              </span>
            ) : null}
            <span className="rounded-full bg-canvas px-2 py-0.5 text-[11px] text-muted">{roleLabel}</span>
          </span>

          <span className="font-mono text-xs text-muted">
            {member.accountNumber} · {member.username}
          </span>
        </span>

        {canManage && !member.isCreator ? (
          <div className="flex shrink-0 gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                onChangeRole(member.role === "viewer" ? "editor" : "viewer");
              }}
              className="text-xs text-brand transition hover:text-brand-dark disabled:opacity-45"
            >
              {member.role === "viewer" ? "改为可编辑" : "改为仅查看"}
            </button>

            <button
              type="button"
              disabled={busy}
              onClick={onAskRemove}
              className="text-xs text-muted transition hover:text-danger disabled:opacity-45"
            >
              移出
            </button>
          </div>
        ) : null}
      </div>

      {/**
        * ⚠️ **The creator has no buttons, and the reason is not seniority.** Demoting or removing them
        * would leave **a ledger nobody can write in and nobody can administer** — no screen could undo
        * it, and the owner's answer for getting rid of a ledger is **整本弃置**, which is the creator's
        * to do.
        */}
      {member.isCreator && canManage ? (
        <p className="text-xs leading-relaxed text-muted">
          创建者不能被降级或移出——否则这本账将没有人能修改。如果你不想再看到它，请用「弃置」。
        </p>
      ) : null}
    </div>
  );
}

/**
 * ⚠️ **Removing somebody asks first**, and this is not politeness: it is the one action here that
 * **takes something away from a person who is not in the room.** Undoing it means inviting them
 * again and waiting for them to accept.
 */
function RemoveConfirm({
  member,
  busy,
  onCancel,
  onConfirm,
}: {
  readonly member: BookMemberView;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  return (
    <div className="rounded-card border border-danger bg-danger-soft px-5 py-4">
      <p className="text-sm text-ink">把 {member.displayName} 移出这本账？</p>
      <p className="mt-2 text-xs leading-relaxed text-muted">
        他会立刻看不到这本账，但他记过的账目会留下，历史记录里也会留下这一条。
        要恢复需要重新邀请，并且要他同意。
      </p>
      <div className="mt-3 flex gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className="rounded-field bg-danger px-4 py-2 text-sm text-white transition hover:bg-danger-dark disabled:opacity-45"
        >
          移出
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-field bg-surface px-4 py-2 text-sm text-muted transition hover:text-ink"
        >
          取消
        </button>
      </div>
    </div>
  );
}
