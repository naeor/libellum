import { PASSWORD_MIN_LENGTH, changePasswordRequestSchema, healthResponseSchema } from "@libellum/shared";
import { useEffect, useState } from "react";

import { useAuth } from "../auth/AuthProvider.js";
import { Alert } from "../components/Alert.js";
import { Button } from "../components/Button.js";
import { Card } from "../components/Card.js";
import { RecoveryCodeCard } from "../components/RecoveryCodeCard.js";
import { TextField } from "../components/TextField.js";
import { apiFetch, errorMessage } from "../lib/api.js";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

export function HomePage(): React.JSX.Element {
  const { user, logout, reload } = useAuth();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordDone, setPasswordDone] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);

  const [codePassword, setCodePassword] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [newCode, setNewCode] = useState<string | null>(null);
  const [codeBusy, setCodeBusy] = useState(false);

  const [databaseStatus, setDatabaseStatus] = useState<string>("…");

  useEffect(() => {
    void apiFetch<unknown>("/health")
      .then((response) => {
        setDatabaseStatus(healthResponseSchema.parse(response).database);
      })
      .catch(() => {
        setDatabaseStatus("unreachable");
      });
  }, []);

  if (!user) return <></>;

  async function changePassword(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setPasswordError(null);
    setPasswordDone(false);

    const parsed = changePasswordRequestSchema.safeParse({ currentPassword, newPassword });
    if (!parsed.success) {
      setPasswordError(parsed.error.issues[0]?.message ?? "请检查填写的内容");
      return;
    }

    setPasswordBusy(true);
    try {
      await apiFetch("/auth/password", { method: "POST", body: parsed.data });
      setCurrentPassword("");
      setNewPassword("");
      setPasswordDone(true);
    } catch (caught) {
      setPasswordError(errorMessage(caught));
    } finally {
      setPasswordBusy(false);
    }
  }

  async function regenerateCode(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setCodeError(null);

    if (codePassword.length === 0) {
      setCodeError("请输入当前密码");
      return;
    }

    setCodeBusy(true);
    try {
      const response = await apiFetch<{ recoveryCode: string }>("/auth/recovery-code", {
        method: "POST",
        body: { password: codePassword },
      });
      setNewCode(response.recoveryCode);
      setCodePassword("");
    } catch (caught) {
      setCodeError(errorMessage(caught));
    } finally {
      setCodeBusy(false);
    }
  }

  async function signOut(): Promise<void> {
    await logout();
    await reload();
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-col gap-5 px-5 py-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm text-muted">你好</p>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{user.displayName}</h1>
        </div>
        <Button variant="ghost" className="w-auto px-3 py-2 text-sm" onClick={() => void signOut()}>
          退出登录
        </Button>
      </header>

      <Card>
        <h2 className="text-sm font-medium text-muted">账号</h2>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
          <dt className="text-muted">用户名</dt>
          <dd className="text-right font-medium text-ink">{user.username}</dd>
          <dt className="text-muted">称呼</dt>
          <dd className="text-right text-ink">{user.displayName}</dd>
          <dt className="text-muted">注册时间</dt>
          <dd className="text-right text-ink">{formatDate(user.createdAt)}</dd>
        </dl>
      </Card>

      <Card>
        <h2 className="text-sm font-medium text-muted">修改密码</h2>
        <form className="mt-4 flex flex-col gap-4" onSubmit={(event) => void changePassword(event)}>
          {passwordError ? <Alert>{passwordError}</Alert> : null}
          {passwordDone ? <Alert tone="success">密码已更新，其它设备上的登录已失效。</Alert> : null}

          <TextField
            label="当前密码"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => {
              setCurrentPassword(event.target.value);
            }}
          />
          <TextField
            label="新密码"
            type="password"
            autoComplete="new-password"
            hint={`至少 ${String(PASSWORD_MIN_LENGTH)} 位`}
            value={newPassword}
            onChange={(event) => {
              setNewPassword(event.target.value);
            }}
          />
          <Button type="submit" variant="secondary" disabled={passwordBusy}>
            {passwordBusy ? "更新中…" : "更新密码"}
          </Button>
        </form>
      </Card>

      <Card>
        <h2 className="text-sm font-medium text-muted">恢复码</h2>
        {newCode ? (
          <div className="mt-4">
            <RecoveryCodeCard code={newCode} onContinue={() => { setNewCode(null); }} />
          </div>
        ) : (
          <form className="mt-4 flex flex-col gap-4" onSubmit={(event) => void regenerateCode(event)}>
            <p className="text-sm leading-relaxed text-muted">
              恢复码只在生成时显示一次。如果你把旧的弄丢了，可以在这里换一个新的（旧的会立即失效）。
            </p>
            {codeError ? <Alert>{codeError}</Alert> : null}
            <TextField
              label="当前密码"
              type="password"
              autoComplete="current-password"
              value={codePassword}
              onChange={(event) => {
                setCodePassword(event.target.value);
              }}
            />
            <Button type="submit" variant="secondary" disabled={codeBusy}>
              {codeBusy ? "生成中…" : "生成新的恢复码"}
            </Button>
          </form>
        )}
      </Card>

      <Card className="bg-brand-soft/40">
        <h2 className="text-sm font-medium text-brand-dark">下一步</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          账号部分到这里就完整了。记账、分类、统计会在 S3 阶段加进来——那时这页会变成你的账本首页。
        </p>
      </Card>

      <p className="mt-auto pt-4 text-center text-xs text-muted">
        API 正常 · 数据库 {databaseStatus === "up" ? "已连接" : databaseStatus}
      </p>
    </main>
  );
}
