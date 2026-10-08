import {
  DISPLAY_NAME_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  registerRequestSchema,
} from "@libellum/shared";
import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";

import { useAuth } from "../auth/AuthProvider.js";
import { Alert } from "../components/Alert.js";
import { AuthLayout } from "../components/AuthLayout.js";
import { Button } from "../components/Button.js";
import { RecoveryCodeCard } from "../components/RecoveryCodeCard.js";
import { TextField } from "../components/TextField.js";
import { errorMessage } from "../lib/api.js";

export function RegisterPage(): React.JSX.Element {
  const { user, register } = useAuth();
  const navigate = useNavigate();

  const [inviteCode, setInviteCode] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

  if (user && !recoveryCode) return <Navigate to="/" replace />;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);

    const parsed = registerRequestSchema.safeParse({
      inviteCode,
      username,
      displayName,
      password,
    });

    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "请检查填写的内容。");
      return;
    }

    setBusy(true);
    try {
      const code = await register(parsed.data);
      setRecoveryCode(code ?? null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (recoveryCode) {
    return (
      <AuthLayout title="恢复码" subtitle="注册已完成。">
        <RecoveryCodeCard
          code={recoveryCode}
          onContinue={() => {
            void navigate("/", { replace: true });
          }}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="创建账号"
      subtitle="注册需要有效的邀请码。"
      footer={
        <>
          已有账号？{" "}
          <Link className="font-medium text-brand-dark hover:underline" to="/login">
            去登录
          </Link>
        </>
      }
    >
      <form className="flex flex-col gap-5" onSubmit={(event) => void submit(event)}>
        {error ? <Alert>{error}</Alert> : null}

        <TextField
          label="邀请码"
          placeholder="XXXX-XXXX-XXXX"
          autoComplete="off"
          value={inviteCode}
          onChange={(event) => {
            setInviteCode(event.target.value);
          }}
        />

        <TextField
          label="用户名"
          hint="3–20 位字母、数字或下划线，用于登录"
          autoComplete="username"
          value={username}
          onChange={(event) => {
            setUsername(event.target.value);
          }}
        />

        <TextField
          label="显示名称"
          hint={`在账目中展示的名称，最多 ${String(DISPLAY_NAME_MAX_LENGTH)} 个字符`}
          value={displayName}
          onChange={(event) => {
            setDisplayName(event.target.value);
          }}
        />

        <TextField
          label="密码"
          type="password"
          autoComplete="new-password"
          hint={`至少 ${String(PASSWORD_MIN_LENGTH)} 位`}
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />

        <Button type="submit" disabled={busy}>
          {busy ? "创建中…" : "创建账号"}
        </Button>
      </form>
    </AuthLayout>
  );
}
