import { useState } from "react";
import { useNavigate } from "react-router";

import { useAuth } from "../auth/AuthProvider.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { DefaultAvatar } from "../components/DefaultAvatar.js";
import { TabPage } from "../components/Layouts.js";
import { APP_VERSION } from "../lib/version.js";

/**
 * The account screen.
 *
 * Shaped like the account page of a phone's settings, because that is the
 * pattern people already know for "the things about me": a mark, a name, then
 * a list of places to go. Everything that used to be crammed into the header —
 * the account number, the settings gear — has moved to the place its label
 * says it belongs, which is also why the account number now appears once.
 *
 * Signing out is deliberately separated from everything else: bottom, on its
 * own, in the warning colour, behind a confirmation like any other action that
 * cannot be trivially undone.
 */
export function MePage(): React.JSX.Element {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  if (!user) return <></>;

  /**
   * One list, in the order somebody would look for things: who I am, then
   * what I manage, then settings.
   */
  const links: { to: string; label: string; hint?: string }[] = [
    { to: "/profile", label: "个人资料", hint: "昵称、用户名、账号编号" },
    { to: "/categories", label: "分类管理", hint: "新增、改名、排序、归档" },
    { to: "/payment-methods", label: "支付方式", hint: "微信、支付宝、银行卡、现金等" },
    { to: "/tags", label: "标签", hint: "出差、可报销等跨分类标记" },
    { to: "/start", label: "我的账本", hint: user.username },
    { to: "/downloads", label: "下载管理", hint: "离线能看哪些月份，以及占用多少空间" },
    /**
     * ⚠️ **The version, where somebody looks when something is wrong.**
     *
     * The owner asked for it here rather than in 设置: "在账户中加入软件更新部分". That is the
     * right place — a version screen is consulted when the program is misbehaving, and the
     * account screen is where the other "about this device and this account" rows live.
     */
    { to: "/update", label: "软件更新", hint: `当前版本 ${APP_VERSION}` },
    { to: "/settings", label: "设置", hint: "默认币种、账号安全、显示与数据" },
  ];

  return (
    <TabPage active="/me" onNavigate={(to) => void navigate(to)}>
      {/*
        The band is taller than its contents and centres them, rather than
        hanging the mark off the top edge with all the slack left underneath.
        The min-height is what keeps the visual weight in the middle of the
        colour instead of at its top.
      */}
      <header className="flex min-h-64 flex-col items-center justify-center gap-3 bg-brand px-6 py-10 text-white">
        <DefaultAvatar />
        <p className="mt-1 truncate text-page-title">{user.displayName}</p>
        <p className="text-xs text-white/75">@{user.username}</p>
      </header>

      <nav className="px-6 pt-5">
        {/**
          * ⚠️ **The row padding is `px-5`, and that is the list convention, not a preference.**
          *
          * The owner's ruling (2026-10-14): *"外层容器不额外设置水平内边距；每一行自行管理内边距；
          * 水平内边距原则上为 20px；分隔线自然贯通列表容器."*
          *
          * ⚠️ **This list was the last one still on `px-6`.** Settings and the category manager had
          * already settled on `px-5`, and the markup here is otherwise *identical* to theirs — same
          * `<ul>` inside the same `rounded-card` frame, same `<li>` → `<button>` → label + hint + `›`.
          * **Two lists with the same job and different padding is the defect**, and the fix is one
          * class rather than a new component.
          */}
        <ul className="overflow-hidden rounded-card border border-line bg-surface">
          {links.map((link) => (
            <li key={link.to}>
              <button
                type="button"
                onClick={() => void navigate(link.to)}
                className="flex w-full items-center justify-between gap-4 border-b border-line px-5 py-4 text-left transition last:border-b-0 hover:bg-canvas"
              >
                <span className="flex flex-col gap-0.5">
                  <span className="text-body text-ink">{link.label}</span>
                  {link.hint === undefined ? null : (
                    <span className="text-helper text-muted">{link.hint}</span>
                  )}
                </span>
                <span className="shrink-0 text-base text-brand">›</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {/**
        * ⚠️ **The account-level referral code used to be rendered right here, and it moved again
        * (2026-10-13).** The owner's instruction: *"账户里边生成邀请码单独包装成一个入口，放到
        * 设置-账号安全里面."*
        *
        * ⚠️ **So it is now a row in 设置 → 账号安全, and the page behind it is `ReferralCodePage`.**
        * Its history is worth keeping in view, because each move was the same correction: it started
        * on the **ledger's collaboration screen** (wrong — it joins nobody to a ledger), then on
        * **账户** as an inline block (right category, wrong weight — it competed with this screen's
        * own list), and now **beside 密码 and 恢复码**, which are the other things that are about the
        * account itself.
        *
        * ⚠️ **The 设置 row names it, so this screen must not grow a second copy.** Two entry points
        * to one quota is how a screen ends up showing a number nothing maintains (`教训.md` §8.12).
        */}

      <div className="px-6 py-8">
        <button
          type="button"
          onClick={() => {
            setConfirmSignOut(true);
          }}
          className="w-full rounded-field bg-danger py-3.5 text-button-lg font-medium text-white shadow-sm transition hover:bg-danger-dark"
        >
          退出登录
        </button>
      </div>

      <ConfirmDialog
        open={confirmSignOut}
        title="退出登录？"
        description="退出后需要重新输入用户名与密码才能查看账目。账目数据不会丢失。"
        consequences={["本设备上的登录状态会立即失效", "如果忘记密码，需要用恢复码重置"]}
        confirmLabel="退出登录"
        onCancel={() => {
          setConfirmSignOut(false);
        }}
        onConfirm={() => {
          setConfirmSignOut(false);

          /**
           * ⚠️ **Signing out replaces the entry instead of adding one, and that is the fix
           * for the loop the owner reported.**
           *
           * "如果登录的时候处于下载管理更多，退出时会退出到下载管理，然后再退出会返回上一步，
           * 也就是下载管理更多" — and his image of where it came from was close: "一般登录时也不会
           * 登录下载管理更多界面，修改一下保底逻辑吧."
           *
           * What happened: `RequireAuth` sends a signed-out user to `/login` with
           * `<Navigate replace>`, which replaces *that one entry* — so every screen the user
           * had visited is still in the browser's history behind it. Pressing 返回 walks back
           * through them, `RequireAuth` bounces each one to `/login`, and the user is thrown
           * forward again. **The history is the bug, not any single screen.**
           *
           * `navigate("/login", { replace: true })` moves the current entry rather than pushing
           * a new one, so signing out leaves one entry behind instead of a trail — and there is
           * nothing to bounce between because there is nothing behind to reach.
           */
          void logout().then(() => {
            void navigate("/login", { replace: true });
          });
        }}
      />
    </TabPage>
  );
}
