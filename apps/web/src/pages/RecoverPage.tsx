import { PASSWORD_MIN_LENGTH, recoverRequestSchema } from "@libellum/shared";
import { useState } from "react";
import { Link, useNavigate } from "react-router";

import { Alert } from "../components/Alert.js";
import { AuthLayout } from "../components/AuthLayout.js";
import { Button } from "../components/Button.js";
import { RecoveryCodeCard } from "../components/RecoveryCodeCard.js";
import { TextField } from "../components/TextField.js";
import { apiFetch, errorMessage } from "../lib/api.js";

export function RecoverPage(): React.JSX.Element {
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [issuedCode, setIssuedCode] = useState<string | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);

    const parsed = recoverRequestSchema.safeParse({ username, recoveryCode, newPassword });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "请检查填写的内容");
      return;
    }

    setBusy(true);
    try {
      const response = await apiFetch<{ recoveryCode: string }>("/auth/recover", {
        method: "POST",
        body: parsed.data,
      });
      setIssuedCode(response.recoveryCode);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (issuedCode) {
    return (
      <AuthLayout title="密码已重置" subtitle="旧密码已失效，请用新密码登录。">
        <RecoveryCodeCard
          code={issuedCode}
          onContinue={() => {
            void navigate("/login", { replace: true });
          }}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="找回密码"
      subtitle="用注册时保存的恢复码重置密码。"
      footer={
        <Link className="font-medium text-brand-dark hover:underline" to="/login">
          返回登录
        </Link>
      }
    >
      <form className="flex flex-col gap-5" onSubmit={(event) => void submit(event)}>
        {error ? <Alert>{error}</Alert> : null}

        <TextField
          label="用户名"
          autoComplete="username"
          autoFocus
          value={username}
          onChange={(event) => {
            setUsername(event.target.value);
          }}
        />

        <TextField
          label="恢复码"
          placeholder="XXXX-XXXX-XXXX-XXXX"
          autoComplete="off"
          hint="大小写和横线都可以随便写，我们会自动识别"
          value={recoveryCode}
          onChange={(event) => {
            setRecoveryCode(event.target.value);
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

        <Button type="submit" disabled={busy}>
          {busy ? "重置中…" : "重置密码"}
        </Button>
      </form>
    </AuthLayout>
  );
}
