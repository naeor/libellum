import { loginRequestSchema } from "@libellum/shared";
import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";

import { useAuth } from "../auth/AuthProvider.js";
import { Alert } from "../components/Alert.js";
import { AuthLayout } from "../components/AuthLayout.js";
import { Button } from "../components/Button.js";
import { TextField } from "../components/TextField.js";
import { errorMessage } from "../lib/api.js";

export function LoginPage(): React.JSX.Element {
  const { user, login } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);

    const parsed = loginRequestSchema.safeParse({ username, password });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "请把用户名和密码填完整");
      return;
    }

    setBusy(true);
    try {
      await login(parsed.data.username, parsed.data.password);
      await navigate("/", { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="登录"
      subtitle="欢迎回来，接着记你的账。"
      footer={
        <>
          还没有账号？{" "}
          <Link className="font-medium text-brand-dark hover:underline" to="/register">
            用邀请码注册
          </Link>
        </>
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
          label="密码"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />

        <Button type="submit" disabled={busy}>
          {busy ? "登录中…" : "登录"}
        </Button>
      </form>

      <p className="text-center text-sm">
        <Link className="text-muted transition hover:text-ink" to="/recover">
          忘记密码了？
        </Link>
      </p>
    </AuthLayout>
  );
}
