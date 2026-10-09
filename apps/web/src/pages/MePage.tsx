import { useState } from "react";
import { useNavigate } from "react-router";

import { useAuth } from "../auth/AuthProvider.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { TabPage } from "../components/Layouts.js";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function GearIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="size-6">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 13.5a7.7 7.7 0 0 0 0-3l1.7-1.3-1.8-3.1-2 .8a7.6 7.6 0 0 0-2.6-1.5L14.4 3h-3.6l-.3 2.4a7.6 7.6 0 0 0-2.6 1.5l-2-.8-1.8 3.1 1.7 1.3a7.7 7.7 0 0 0 0 3l-1.7 1.3 1.8 3.1 2-.8a7.6 7.6 0 0 0 2.6 1.5l.3 2.4h3.6l.3-2.4a7.6 7.6 0 0 0 2.6-1.5l2 .8 1.8-3.1-1.7-1.3Z" />
    </svg>
  );
}

/**
 * Account and destination screen.
 *
 * Signing out is deliberately separated from everything else: it sits at the
 * very bottom on its own, in the warning colour, and asks for confirmation
 * like any other action that is not trivially reversible.
 */
export function MePage(): React.JSX.Element {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  if (!user) return <></>;

  const links: { to: string; label: string; hint: string }[] = [
    { to: "/categories", label: "分类管理", hint: "新增、改名、排序、归档" },
    { to: "/payment-methods", label: "支付方式", hint: "微信、支付宝、现金等" },
    { to: "/tags", label: "标签", hint: "出差、可报销等跨分类标记" },
    { to: "/books", label: "我的账本", hint: user.username },
  ];

  return (
    <TabPage active="/me" onNavigate={(to) => void navigate(to)}>
      {/* Carries the accent colour the way the 明细 header does, so the two
          main screens read as the same product rather than one coloured page
          and one plain one. */}
      <header className="flex items-center justify-between gap-4 bg-brand px-6 pt-8 pb-6 text-white">
        <div className="min-w-0">
          <p className="text-sm text-white/80">我的</p>
          <h1 className="truncate text-2xl font-semibold tracking-tight">{user.displayName}</h1>
          <p className="mt-1 text-xs text-white/75">账号编号 {user.accountNumber}</p>
        </div>
        <button
          type="button"
          aria-label="设置"
          onClick={() => void navigate("/settings")}
          className="shrink-0 text-white/85 transition hover:text-white"
        >
          <GearIcon />
        </button>
      </header>

      <section className="px-6 pt-4">
        <div className="rounded-card border border-line bg-surface p-5">
          <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-3 text-sm">
            <dt className="text-muted">昵称</dt>
            <dd className="text-right text-ink">{user.displayName}</dd>

            <dt className="text-muted">用户名</dt>
            <dd className="text-right text-ink">{user.username}</dd>

            <dt className="text-muted">注册时间</dt>
            <dd className="text-right text-ink">{formatDateTime(user.createdAt)}</dd>

            <dt className="text-muted">账号编号</dt>
            <dd className="text-right font-mono tracking-wide text-ink">{user.accountNumber}</dd>
          </dl>

          <p className="mt-5 border-t border-line pt-4 text-xs leading-relaxed text-muted">
            用户名与账号编号都可以安全地提供给他人，用来把你添加为协作者；恢复码必须保密。
          </p>
        </div>
      </section>

      <nav className="px-6 pt-5">
        <ul className="overflow-hidden rounded-card border border-line bg-surface">
          {links.map((link) => (
            <li key={link.to}>
              <button
                type="button"
                onClick={() => void navigate(link.to)}
                className="flex w-full items-center justify-between gap-4 border-b border-line px-6 py-4 text-left transition last:border-b-0 hover:bg-canvas"
              >
                <span className="text-sm text-ink">{link.label}</span>
                <span className="text-base text-brand">›</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="px-6 py-8">
        <button
          type="button"
          onClick={() => {
            setConfirmSignOut(true);
          }}
          className="w-full rounded-field bg-danger py-3.5 text-[15px] font-medium text-white shadow-sm transition hover:bg-danger-dark"
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
          void logout();
        }}
      />
    </TabPage>
  );
}
