import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { Alert } from "../components/Alert.js";
import { Button } from "../components/Button.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { CopyButton } from "../components/CopyButton.js";
import { InnerPage } from "../components/Layouts.js";
import { SectionFrame } from "../components/SectionFrame.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { TextField } from "../components/TextField.js";
import {
  createAdminInvite,
  fetchAdminAudit,
  fetchAdminInvites,
  fetchAdminOverview,
  fetchAdminRoster,
  fetchAdminSelf,
  restoreAdminUser,
  revokeAdminInvite,
  searchAdminUsers,
  suspendAdminUser,
} from "../lib/admin.js";
import { errorMessage } from "../lib/api.js";
import type {
  AdminAuditListResponse,
  AdminInvite,
  AdminOverviewResponse,
  AdminRosterResponse,
  AdminUserSearchResponse,
} from "@libellum/shared";

/**
 * **系统管理（S13-B）**
 *
 * ⚠️ **Every screen here is a view of what the server already decided.** The pages call the
 * admin API and render the answer; they do not filter, and they do not hide data the API sent.
 * Hiding a control in the browser has never made an endpoint safe, and the reverse is also true:
 * a screen that quietly dropped a row would make the console disagree with the database.
 *
 * ⚠️ **Nothing on these screens is a ledger.** The API cannot return one, and no page asks for
 * one — *"管理员可以管理系统，不应因此默认拥有查看所有私人账本的权限"*.
 */

type Load<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly data: T };

/** One async load with a retry, so every screen behaves the same way. */
function useLoad<T>(load: () => Promise<T>): {
  readonly state: Load<T>;
  readonly reload: () => void;
} {
  const [state, setState] = useState<Load<T>>({ kind: "loading" });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });

    void load()
      .then((data) => {
        if (!cancelled) setState({ kind: "ready", data });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ kind: "error", message: errorMessage(error) });
      });

    return () => {
      cancelled = true;
    };
    // `load` is recreated on every render by callers; `tick` is the explicit refresh signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  return { state, reload: () => { setTick((value) => value + 1); } };
}

/**
 * **The gate.** Asks the server once; renders the page only if the answer is yes.
 *
 * ⚠️ **A refusal is silent in the sense that matters**: the console does not explain which check
 * failed (the server never says), it simply is not there. The navigation happens after the
 * answer, so a non-administrator never sees a flash of admin UI.
 */
function useAdminGate(): { readonly allowed: boolean | null } {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;

    void fetchAdminSelf()
      .then((self) => {
        if (cancelled) return;
        setAllowed(self !== null);
        if (self === null) navigate("/me", { replace: true });
      })
      .catch(() => {
        if (!cancelled) {
          setAllowed(false);
          navigate("/me", { replace: true });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [navigate]);

  return { allowed };
}

function Shell({
  title,
  backTo = "/admin",
  children,
}: {
  readonly title: string;
  readonly backTo?: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const { allowed } = useAdminGate();

  return (
    <InnerPage title={title} backTo={backTo}>
      {allowed === true ? children : <SkeletonRows rows={4} />}
    </InnerPage>
  );
}

/** A read-only label/value row, the same shape the settings screen uses. */
function InfoRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-3.5 last:border-b-0">
      <span className="text-sm text-ink">{label}</span>
      <span className="shrink-0 text-helper text-muted">{value}</span>
    </div>
  );
}

/** `2026/10/17 10:32` — the console is a desktop screen, so a compact timestamp is fine. */
function stamp(value: string | null): string {
  if (value === null) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";

  return parsed.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function count(value: number): string {
  return String(value);
}

// ---------------------------------------------------------------------------
// /admin — overview
// ---------------------------------------------------------------------------
export function AdminOverviewPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { state, reload } = useLoad(fetchAdminOverview);

  return (
    <Shell title="系统管理">
      {state.kind === "loading" ? <SkeletonRows rows={5} /> : null}
      {state.kind === "error" ? <ErrorState message={state.message} onRetry={reload} /> : null}
      {state.kind === "ready" ? <OverviewBody data={state.data} onNavigate={navigate} /> : null}
    </Shell>
  );
}

function OverviewBody({
  data,
  onNavigate,
}: {
  readonly data: AdminOverviewResponse;
  readonly onNavigate: (to: string) => void;
}): React.JSX.Element {
  return (
    <>
      <SectionFrame title="概览">
        <InfoRow label="账号总数" value={count(data.users.total)} />
        <InfoRow label="已停用账号" value={count(data.users.suspended)} />
        <InfoRow label="账本总数" value={count(data.books.total)} />
        <InfoRow
          label="管理员"
          value={
            data.admins.halfConfigured > 0
              ? `${count(data.admins.active)}（另有 ${count(data.admins.halfConfigured)} 个只满足一半）`
              : count(data.admins.active)
          }
        />
      </SectionFrame>

      <SectionFrame title="邀请码">
        <InfoRow label="可用" value={count(data.invites.available)} />
        <InfoRow label="已使用" value={count(data.invites.used)} />
        <InfoRow label="已作废" value={count(data.invites.revoked)} />
        <InfoRow label="已过期" value={count(data.invites.expired)} />
      </SectionFrame>

      <SectionFrame title="备份">
        {data.lastBackup === null ? (
          /**
           * ⚠️ **"还没有记录" is the honest answer, and it must stay that way until the backup
           * script starts writing rows.** A screen that turned "no data" into "看起来正常"
           * would be inventing reassurance.
           */
          <p className="px-5 py-4 text-body-relaxed text-muted">
            还没有备份记录。备份脚本尚未接入，所以这里不会显示"正常"。
          </p>
        ) : (
          <>
            <InfoRow label="上次备份" value={stamp(data.lastBackup.at)} />
            <InfoRow label="结果" value={data.lastBackup.ok ? "成功（含恢复演练）" : "失败"} />
            {data.lastBackup.note === null ? null : (
              <InfoRow label="备注" value={data.lastBackup.note} />
            )}
          </>
        )}
      </SectionFrame>

      <SectionFrame
        title="最近操作"
        action={
          <button
            type="button"
            className="text-brand transition hover:text-brand-dark"
            onClick={() => { onNavigate("/admin/audit"); }}
          >
            全部 ›
          </button>
        }
      >
        {data.recentActions.length === 0 ? (
          <p className="px-5 py-4 text-body-relaxed text-muted">还没有管理操作。</p>
        ) : (
          data.recentActions.map((entry) => (
            <div
              key={entry.id}
              className="flex items-center justify-between gap-4 border-b border-line px-5 py-3.5 last:border-b-0"
            >
              <span className="flex flex-col gap-0.5">
                <span className="text-sm text-ink">{entry.action}</span>
                <span className="text-helper text-muted">
                  {entry.adminUsername}
                  {entry.target === null ? "" : ` · ${entry.target}`}
                </span>
              </span>
              <span className="shrink-0 text-helper text-muted">{stamp(entry.at)}</span>
            </div>
          ))
        )}
      </SectionFrame>

      <div className="flex flex-col gap-3 px-6 py-7">
        <Button variant="secondary" onClick={() => { onNavigate("/admin/invites"); }}>
          邀请码管理
        </Button>
        <Button variant="secondary" onClick={() => { onNavigate("/admin/admins"); }}>
          管理员状态
        </Button>
        <Button variant="secondary" onClick={() => { onNavigate("/admin/users"); }}>
          查找账号
        </Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// /admin/invites
// ---------------------------------------------------------------------------
const STATUS_LABEL: Record<AdminInvite["status"], string> = {
  available: "可用",
  used: "已使用",
  revoked: "已作废",
  expired: "已过期",
};

export function AdminInvitesPage(): React.JSX.Element {
  const { state, reload } = useLoad(fetchAdminInvites);
  const [created, setCreated] = useState<{ code: string; note: string | null } | null>(null);
  const [shape, setShape] = useState<"ordinary" | "reserved">("ordinary");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<AdminInvite | null>(null);

  const submit = useCallback(() => {
    setBusy(true);
    setMessage(null);

    void createAdminInvite({ shape, ...(note.trim() === "" ? {} : { note: note.trim() }) })
      .then((response) => {
        setCreated({ code: response.code, note: response.invite.note });
        setNote("");
        reload();
      })
      .catch((error: unknown) => { setMessage(errorMessage(error)); })
      .finally(() => { setBusy(false); });
  }, [shape, note, reload]);

  return (
    <Shell title="邀请码">
      <SectionFrame title="创建邀请码">
        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="flex gap-2">
            <Button
              variant={shape === "ordinary" ? "primary" : "secondary"}
              fullWidth={false}
              onClick={() => { setShape("ordinary"); }}
            >
              7 天有效
            </Button>
            <Button
              variant={shape === "reserved" ? "primary" : "secondary"}
              fullWidth={false}
              onClick={() => { setShape("reserved"); }}
            >
              预留编号·永久
            </Button>
          </div>

          <p className="text-helper-relaxed text-muted">
            {shape === "ordinary"
              ? "7 天后自动过期，可作废。适合「现在就要发一个码」的场合。"
              : "预留一个前 100 的账号编号、永不过期。编号一旦预留就不会退回。"}
          </p>

          <TextField
            label="备注（只有你自己看得到）"
            value={note}
            maxLength={200}
            onChange={(event) => { setNote(event.target.value); }}
            placeholder="例如：给母亲"
          />

          {message === null ? null : <Alert tone="error">{message}</Alert>}

          <Button disabled={busy} onClick={submit}>
            {busy ? "创建中…" : "创建"}
          </Button>
        </div>
      </SectionFrame>

      {created === null ? null : (
        <SectionFrame title="新邀请码（只显示这一次）">
          <div className="flex flex-col gap-3 px-5 py-4">
            <Alert tone="info">
              离开这个页面后就再也看不到这个码了。请现在复制或用截图保存。
            </Alert>
            <CopyButton text={created.code} label="复制邀请码" hint="邀请码只显示这一次" />
            <Button variant="ghost" onClick={() => { setCreated(null); }}>
              我已保存
            </Button>
          </div>
        </SectionFrame>
      )}

      <SectionFrame title="全部邀请码">
        {state.kind === "loading" ? <SkeletonRows rows={4} /> : null}
        {state.kind === "error" ? <ErrorState message={state.message} onRetry={reload} /> : null}
        {state.kind === "ready" ? (
          state.data.invites.length === 0 ? (
            <EmptyState title="还没有邀请码" description="上面可以创建一个。" />
          ) : (
            <InviteList invites={state.data.invites} onRevoke={setRevoking} />
          )
        ) : null}
      </SectionFrame>

      {revoking === null ? null : (
        <RevokeInviteDialog
          invite={revoking}
          onCancel={() => { setRevoking(null); }}
          onDone={() => { setRevoking(null); reload(); }}
        />
      )}
    </Shell>
  );
}

function InviteList({
  invites,
  onRevoke,
}: {
  readonly invites: readonly AdminInvite[];
  readonly onRevoke: (invite: AdminInvite) => void;
}): React.JSX.Element {
  return (
    <>
      {invites.map((invite) => (
        <div
          key={invite.id}
          className="flex items-start justify-between gap-4 border-b border-line px-5 py-4 last:border-b-0"
        >
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="font-mono text-sm text-ink">{invite.maskedCode}</span>
            <span className="truncate text-helper text-muted">
              {invite.note ?? "（无备注）"}
              {invite.accountNumber === null ? "" : ` · 预留 ${invite.accountNumber}`}
            </span>
            <span className="text-helper text-muted">
              {STATUS_LABEL[invite.status]}
              {invite.usedByUsername === null ? "" : ` · ${invite.usedByUsername}`}
              {` · ${stamp(invite.createdAt)}`}
            </span>
          </span>
          {invite.status === "revoked" ? null : (
            <button
              type="button"
              className="shrink-0 text-xs text-danger transition hover:text-danger-dark"
              onClick={() => { onRevoke(invite); }}
            >
              作废
            </button>
          )}
        </div>
      ))}
    </>
  );
}

/**
 * Revoking asks for a reason **and the administrator's password**.
 *
 * ⚠️ **The password is the second factor, and it is checked by the server** — the dialog only
 * collects it. A confirmation dialog alone protects nobody: the rule has to hold for a request
 * that never rendered the dialog.
 */
function RevokeInviteDialog({
  invite,
  onCancel,
  onDone,
}: {
  readonly invite: AdminInvite;
  readonly onCancel: () => void;
  readonly onDone: () => void;
}): React.JSX.Element {
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [acknowledge, setAcknowledge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const needsAcknowledgement = invite.status === "used";

  return (
    <ConfirmDialog
      open
      tone="danger"
      title="作废邀请码？"
      description={`${invite.maskedCode}${invite.note === null ? "" : `（${invite.note}）`}`}
      consequences={[
        "作废后这个码不能再被用来注册。",
        ...(needsAcknowledgement
          ? [
              "⚠️ 这个码已经被注册使用过：作废它不会关闭已注册的账户。",
              "那个账户仍然是可用状态，需要你单独处理。",
            ]
          : ["预留编号不会退回。"]),
      ]}
      confirmLabel="作废"
      busy={busy}
      onCancel={onCancel}
      onConfirm={() => {
        if (reason.trim() === "" || password === "") {
          setMessage("需要填写原因并输入你的密码。");
          return;
        }
        if (needsAcknowledgement && !acknowledge) {
          setMessage("请先确认你已经读过「不会关闭账户」的提示。");
          return;
        }

        setBusy(true);
        setMessage(null);

        void revokeAdminInvite(invite.id, {
          reason: reason.trim(),
          password,
          ...(needsAcknowledgement ? { acknowledgeUsed: true } : {}),
        })
          .then(onDone)
          .catch((error: unknown) => { setMessage(errorMessage(error)); })
          .finally(() => { setBusy(false); });
      }}
    >
      <div className="mt-4 flex flex-col gap-3">
        <TextField
          label="原因（会记进操作记录）"
          value={reason}
          maxLength={200}
          onChange={(event) => { setReason(event.target.value); }}
        />
        <TextField
          label="你的密码（二次验证）"
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(event) => { setPassword(event.target.value); }}
        />
        {needsAcknowledgement ? (
          <label className="flex items-start gap-2 text-helper-relaxed text-muted">
            <input
              type="checkbox"
              checked={acknowledge}
              onChange={(event) => { setAcknowledge(event.target.checked); }}
              className="mt-0.5"
            />
            <span>我知道作废邀请码不会关闭已经注册的账户。</span>
          </label>
        ) : null}
        {message === null ? null : <Alert tone="error">{message}</Alert>}
      </div>
    </ConfirmDialog>
  );
}

// ---------------------------------------------------------------------------
// /admin/admins — read-only on purpose
// ---------------------------------------------------------------------------
const ROSTER_LABEL: Record<string, string> = {
  active: "管理员",
  grant_only: "只满足一半：有授权、不在允许名单",
  allowlist_only: "只满足一半：在允许名单、无授权",
  eligible: "有资格，未授权",
};

export function AdminAdminsPage(): React.JSX.Element {
  const { state, reload } = useLoad(fetchAdminRoster);

  return (
    <Shell title="管理员">
      <SectionFrame title="当前状态">
        {state.kind === "loading" ? <SkeletonRows rows={3} /> : null}
        {state.kind === "error" ? <ErrorState message={state.message} onRetry={reload} /> : null}
        {state.kind === "ready" ? <RosterList data={state.data} /> : null}
      </SectionFrame>

      <SectionFrame title="为什么这里不能授权">
        <p className="px-5 py-4 text-body-relaxed text-muted">
          授权与撤销管理员需要同时写入「授权」和「允许名单」两处记录，只能在服务器终端用
          <code className="mx-1 font-mono text-xs">admin:grant</code> 与
          <code className="mx-1 font-mono text-xs">admin:allow</code> 完成。
        </p>
        <p className="px-5 pb-4 text-body-relaxed text-muted">
          如果网页能提权，那么一个被盗的管理员会话就等于多了一把能开同一把锁的钥匙——这正是两道锁要防的事。
        </p>
      </SectionFrame>
    </Shell>
  );
}

function RosterList({ data }: { readonly data: AdminRosterResponse }): React.JSX.Element {
  if (data.entries.length === 0) {
    return <EmptyState title="没有可显示的账号" description="前 100 个账号才会出现在这里。" />;
  }

  return (
    <>
      <p className="px-5 py-3 text-helper text-muted">
        有资格账号共 {count(data.eligibleTotal)} 个（编号 10000000–10000099）。
      </p>
      {data.entries.map((entry) => (
        <div key={entry.userId} className="flex items-center justify-between gap-4 border-t border-line px-5 py-3.5">
          <span className="flex flex-col gap-0.5">
            <span className="text-sm text-ink">
              {entry.username} · {entry.accountNumber}
            </span>
            <span
              className={`text-helper ${entry.status === "active" ? "text-brand-dark" : "text-muted"}`}
            >
              {ROSTER_LABEL[entry.status] ?? entry.status}
            </span>
          </span>
          <span className="shrink-0 text-helper text-muted">
            {entry.status === "active" ? stamp(entry.grantedAt) : ""}
          </span>
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// /admin/users
// ---------------------------------------------------------------------------
export function AdminUsersPage(): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<AdminUserSearchResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<{
    user: AdminUserSearchResponse["users"][number];
    kind: "suspend" | "restore";
  } | null>(null);

  const search = useCallback(() => {
    const trimmed = query.trim();
    if (trimmed === "") {
      setResult(null);
      setMessage(null);
      return;
    }

    setBusy(true);
    setMessage(null);

    void searchAdminUsers(trimmed)
      .then(setResult)
      .catch((error: unknown) => { setMessage(errorMessage(error)); })
      .finally(() => { setBusy(false); });
  }, [query]);

  return (
    <Shell title="查找账号">
      <SectionFrame title="精确查找" bare>
        <div className="flex flex-col gap-3 px-6">
          <TextField
            label="账号编号或用户名（完整匹配）"
            value={query}
            onChange={(event) => { setQuery(event.target.value); }}
            placeholder="例如 10000101 或 naeor"
            onKeyDown={(event) => {
              if (event.key === "Enter") search();
            }}
          />
          <Button disabled={busy} onClick={search}>
            {busy ? "查找中…" : "查找"}
          </Button>
          <p className="text-helper text-muted">
            只支持完整编号或完整用户名——不做模糊列表，因为"能管理用户"不等于"能浏览所有人"。
          </p>
          {message === null ? null : <Alert tone="error">{message}</Alert>}
        </div>
      </SectionFrame>

      {result === null ? null : (
        <SectionFrame title="结果">
          {result.users.length === 0 ? (
            <EmptyState title="没有找到" description="需要输入完整的 8 位编号或完整用户名。" />
          ) : (
            result.users.map((user) => (
              <div key={user.userId} className="flex flex-col gap-2 border-b border-line px-5 py-4 last:border-b-0">
                <span className="text-sm text-ink">
                  {user.username} · {user.accountNumber}
                </span>
                <span className="text-helper text-muted">
                  {user.displayName} · 注册于 {stamp(user.createdAt)}
                  {user.isDemo ? " · 演示账号" : ""}
                  {user.isActiveAdmin ? " · 管理员" : ""}
                  {user.suspendedAt === null ? "" : ` · 已于 ${stamp(user.suspendedAt)} 停用`}
                  {` · ${count(user.activeSessions)} 台设备在线`}
                </span>
                <Button
                  variant={user.suspendedAt === null ? "danger" : "secondary"}
                  fullWidth={false}
                  onClick={() => {
                    setAction({ user, kind: user.suspendedAt === null ? "suspend" : "restore" });
                  }}
                >
                  {user.suspendedAt === null ? "停用账户" : "恢复账户"}
                </Button>
              </div>
            ))
          )}
        </SectionFrame>
      )}

      {action === null ? null : (
        <AccountActionDialog
          user={action.user}
          kind={action.kind}
          onCancel={() => { setAction(null); }}
          onDone={() => {
            setAction(null);
            search();
          }}
        />
      )}
    </Shell>
  );
}

function AccountActionDialog({
  user,
  kind,
  onCancel,
  onDone,
}: {
  readonly user: AdminUserSearchResponse["users"][number];
  readonly kind: "suspend" | "restore";
  readonly onCancel: () => void;
  readonly onDone: () => void;
}): React.JSX.Element {
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const suspending = kind === "suspend";

  return (
    <ConfirmDialog
      open
      tone={suspending ? "danger" : "default"}
      title={suspending ? "停用账户？" : "恢复账户？"}
      description={`${user.username}（${user.accountNumber}）`}
      consequences={
        suspending
          ? [
              `该账号在 ${count(user.activeSessions)} 台设备上的登录会被立即清除。`,
              "停用后无法登录，登录页只会提示「该账户目前已停用或不存在」。",
              "账本与流水不会被删除；账户随时可以恢复。",
            ]
          : ["账户将恢复登录能力。", "之前的登录会话不会恢复，需要重新登录。"]
      }
      confirmLabel={suspending ? "停用" : "恢复"}
      busy={busy}
      onCancel={onCancel}
      onConfirm={() => {
        if (reason.trim() === "" || password === "") {
          setMessage("需要填写原因并输入你的密码。");
          return;
        }

        setBusy(true);
        setMessage(null);

        const body = { reason: reason.trim(), password };
        const call = suspending
          ? suspendAdminUser(user.userId, body)
          : restoreAdminUser(user.userId, body);

        void call
          .then(onDone)
          .catch((error: unknown) => { setMessage(errorMessage(error)); })
          .finally(() => { setBusy(false); });
      }}
    >
      <div className="mt-4 flex flex-col gap-3">
        <TextField
          label="原因（会记进操作记录）"
          value={reason}
          maxLength={200}
          onChange={(event) => { setReason(event.target.value); }}
        />
        <TextField
          label="你的密码（二次验证）"
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(event) => { setPassword(event.target.value); }}
        />
        {message === null ? null : <Alert tone="error">{message}</Alert>}
      </div>
    </ConfirmDialog>
  );
}

// ---------------------------------------------------------------------------
// /admin/audit
// ---------------------------------------------------------------------------
export function AdminAuditPage(): React.JSX.Element {
  const { state, reload } = useLoad(fetchAdminAudit);

  return (
    <Shell title="操作记录">
      <SectionFrame title="最近 50 条">
        {state.kind === "loading" ? <SkeletonRows rows={5} /> : null}
        {state.kind === "error" ? <ErrorState message={state.message} onRetry={reload} /> : null}
        {state.kind === "ready" ? <AuditList data={state.data} /> : null}
      </SectionFrame>
      <SectionFrame title="说明">
        <p className="px-5 py-4 text-body-relaxed text-muted">
          操作记录永久保留，不会自动清理，也不可编辑或删除。记录里不包含密码、会话、恢复码或邀请码明文。
        </p>
      </SectionFrame>
    </Shell>
  );
}

function AuditList({ data }: { readonly data: AdminAuditListResponse }): React.JSX.Element {
  if (data.entries.length === 0) {
    return <EmptyState title="还没有操作记录" description="管理操作会出现在这里。" />;
  }

  return (
    <>
      {data.entries.map((entry) => (
        <div key={entry.id} className="flex items-start justify-between gap-4 border-b border-line px-5 py-3.5 last:border-b-0">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm text-ink">{entry.action}</span>
            <span className="truncate text-helper text-muted">
              {entry.adminUsername}
              {entry.target === null ? "" : ` · ${entry.target}`}
              {entry.outcome === "failed" ? " · 被拒绝" : ""}
            </span>
          </span>
          <span className="shrink-0 text-helper text-muted">{stamp(entry.at)}</span>
        </div>
      ))}
    </>
  );
}
