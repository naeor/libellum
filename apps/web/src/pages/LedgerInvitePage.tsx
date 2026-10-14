import { useState } from "react";
import { Link } from "react-router";

import { Button } from "../components/Button.js";
import { InnerPage } from "../components/Layouts.js";
import { MemberList } from "../components/MemberList.js";
import { TextField } from "../components/TextField.js";
import { errorMessage } from "../lib/api.js";
import { useInviteToBook, useLedger, useLookupAccount, type DirectoryAccount } from "../lib/queries.js";

/**
 * **邀请成员 —— 直接邀请某个人加入当前账本。**
 *
 * ⚠️ **This page used to send people somewhere else.** It said *"在「协作者」页面按对方账号编号找到
 * 他，然后邀请他加入这本账"* and offered a 去邀请 button pointing at `/collaborators`. The owner's
 * complaint is the reason it now does the work itself:
 *
 * > *"不再通过「邀请新成员 → 去邀请 → 协作者」这一冗长路径."*
 *
 * ⚠️ **⚠️ The server never required the detour.** `POST /books/invite` has taken an account number
 * and a role directly since 2026-10-12 — the account-level collaborator step in front of it was
 * removed then. **What was left was the screen still describing it**, which is why this file changed
 * and the route did not.
 *
 * ⚠️ **The flow is one confirmation, and it is the invitee's**: search → pick a role → send →
 * they accept → they are a member. *"一次账本邀请只需要一次接受确认"*, and *"邀请发出时不能立即授予
 * 账本访问权限."* Nothing on this screen grants anything; it only asks.
 */
export function LedgerInvitePage(): React.JSX.Element {
  const ledger = useLedger();
  const lookup = useLookupAccount();
  const invite = useInviteToBook();

  const [query, setQuery] = useState("");
  const [account, setAccount] = useState<DirectoryAccount | null>(null);
  const [invitation, setInvitation] = useState<
    { id: string; status: "pending" | "accepted" | "declined" } | null
  >(null);
  const [canInvite, setCanInvite] = useState(true);
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bookName = ledger.data?.book.name ?? "这本账";

  /**
   * ⚠️ **One box for both ways of naming somebody**, because the server takes either and the user
   * should not have to classify what they typed. The shape decides: **eight digits is a number,
   * anything else is a username** — and the server validates both, so a wrong guess is a clear error
   * and not a silent miss.
   *
   * ⚠️ **Exact values only, both ways** (see `collab/directory.ts`): a prefix search would let
   * anybody walk the user base one character at a time. **Nothing here weakens that** — a partial
   * value simply finds nobody.
   */
  function lookupInput(): { accountNumber?: string; username?: string } {
    const value = query.trim();
    return /^[0-9]{8}$/.test(value) ? { accountNumber: value } : { username: value };
  }

  function runLookup(): void {
    const input = lookupInput();
    if ((input.accountNumber ?? input.username ?? "") === "") return;

    setError(null);
    setAccount(null);
    setInvitation(null);
    setSent(false);

    void lookup
      .mutateAsync(input)
      .then((found) => {
        setAccount(found.account);
        setInvitation(found.invitation);
        setCanInvite(found.canInvite);
      })
      .catch((caught: unknown) => {
        setError(errorMessage(caught));
      });
  }

  function send(): void {
    if (account === null) return;

    setError(null);

    void invite
      .mutateAsync({
        ...(query.trim() !== "" && /^[0-9]{8}$/.test(query.trim())
          ? { accountNumber: account.accountNumber }
          : { username: account.username }),
        role,
      })
      .then(() => {
        setSent(true);
        /**
         * ⚠️ **Re-read the invitation rather than assuming it**, so the card shows what the server
         * now holds — including the "refreshed" case, where an invitation was already waiting and
         * this only changed its role.
         */
        return lookup.mutateAsync(lookupInput());
      })
      .then((again) => {
        setInvitation(again.invitation);
      })
      .catch((caught: unknown) => {
        setError(errorMessage(caught));
      });
  }

  return (
    <InnerPage
      title="邀请成员"
      subtitle={`把别人请进「${bookName}」`}
      backTo="/ledger"
    >
      {/**
        * ⚠️ **The search card.** It is the whole point of the page: *"通过用户名或账号编号搜索目标用户"*
        * and *"选择目标用户及其账本权限"* and *"发送加入当前账本的邀请."*
        */}
      <div className="flex flex-col gap-4 rounded-card border border-line bg-surface p-5">
        <h2 className="text-sm font-medium text-ink">邀请某个人</h2>

        <TextField
          label="账号编号或用户名"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") runLookup();
          }}
          placeholder="10000003 或 naeor"
          hint="要完整的 8 位编号，或完整的用户名。只按前缀查找是不行的。"
          inputMode="text"
          autoComplete="off"
        />

        <div className="flex gap-3">
          <Button
            fullWidth={false}
            disabled={lookup.isPending || query.trim() === ""}
            onClick={runLookup}
          >
            {lookup.isPending ? "正在查找……" : "查找"}
          </Button>
        </div>

        {error === null ? null : (
          <p role="alert" className="rounded-field bg-danger-soft px-4 py-3 text-body text-danger">
            {error}
          </p>
        )}

        {/**
          * ⚠️ **Found, and what to do about it.** The role is chosen here rather than on a later
          * screen, which is the owner's step 4 — *"选择目标用户及其账本权限"* — and it travels with the
          * invitation (`notifications.payload`), so what the sender chose is what acceptance grants.
          */}
        {account === null ? null : (
          <div className="flex flex-col gap-4 rounded-card border border-brand/30 bg-brand-soft/30 p-4">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-base font-medium text-ink">{account.displayName}</span>
              <span className="truncate text-helper text-muted">
                {account.username} · <span className="font-mono">{account.accountNumber}</span>
              </span>
            </div>

            {account.alreadyMember ? (
              /** ⚠️ Stated instead of offering a button the server would refuse. */
              <p className="text-body-relaxed text-muted">
                这个人已经在这本账里了。
              </p>
            ) : (
              <>
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1 text-body text-ink">给他什么权限</legend>

                  {(
                    [
                      { value: "editor", label: "可以记账和修改", hint: "能记账、改账、邀请别人" },
                      { value: "viewer", label: "只能查看", hint: "能看账目，不能改动" },
                    ] as const
                  ).map((option) => (
                    <label key={option.value} className="flex items-start gap-3 text-body text-ink">
                      <input
                        type="radio"
                        name="invite-role"
                        value={option.value}
                        checked={role === option.value}
                        onChange={() => {
                          setRole(option.value);
                        }}
                        className="mt-1"
                      />
                      <span>
                        {option.label}
                        <span className="mt-0.5 block text-helper-relaxed text-muted">
                          {option.hint}
                        </span>
                      </span>
                    </label>
                  ))}
                </fieldset>

                {/**
                  * ⚠️ **A viewer may not invite**, and the server refuses it too — the screen says so
                  * rather than hiding the button, because **a control that disappears reads as a bug**
                  * and the reason is something the reader can act on.
                  */}
                {canInvite ? (
                  <Button disabled={invite.isPending} onClick={send}>
                    {invite.isPending ? "正在发送……" : "发送邀请"}
                  </Button>
                ) : (
                  <p className="rounded-field bg-canvas px-4 py-3 text-body-relaxed text-muted">
                    你在这本账里只能查看，不能邀请别人。请让有编辑权限的成员来邀请。
                  </p>
                )}

                {/**
                  * ⚠️ **The state of an invitation already sent, from the server.** The owner asked
                  * that *"邀请接受或拒绝后，状态正确更新"* — and this is where the sender finds out,
                  * because they are the one looking the person up again.
                  */}
                {invitation === null ? null : (
                  <p className="text-helper-relaxed text-muted">
                    {invitation.status === "pending"
                      ? "已经邀请过他了，正在等他确认。再发一次只会刷新那条邀请，不会多发一条。"
                      : invitation.status === "declined"
                        ? "他上次拒绝了。你可以再邀请一次，或者先问问他的想法。"
                        : "他已经接受过邀请，现在是这本账的成员。"}
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {sent ? (
          <p role="status" className="rounded-field bg-brand-soft px-4 py-3 text-body text-brand-dark">
            邀请已经发出。他会收到一条通知，接受之后才真正加入。
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-5">
        <h2 className="text-sm font-medium text-ink">已经在账本里的人</h2>
        <MemberList />
      </div>

      {/**
        * ⚠️ **The sharing link, named as the third way in.** The owner keeps the concepts apart —
        * 邀请成员（点名邀请）· 分享链接（链接邀请）· 邀请码（注册账号）— and this sentence is where
        * the second one is pointed at, so somebody holding a link need not go looking.
        */}
      <p className="text-helper-relaxed text-muted">
        想一次请多个人，或者不方便当面输入编号，可以用分享链接——它在账本详情里。
        用于注册账号的邀请码不在这里，它属于账号本身，在「账户」页面。
      </p>

      <Link to="/ledger" className="text-body text-brand transition hover:text-brand-dark">
        ‹ 返回账本
      </Link>
    </InnerPage>
  );
}
