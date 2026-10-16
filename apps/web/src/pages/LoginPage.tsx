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
  const { user, login, sessionRevoked } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const next = new URLSearchParams(window.location.search).get("next");
  const destination = next !== null && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/";
  if (user) return <Navigate to={destination} replace />;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);

    const parsed = loginRequestSchema.safeParse({ username, password });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "请填写用户名和密码。");
      return;
    }

    setBusy(true);
    try {
      await login(parsed.data.username, parsed.data.password);
      /**
       * ⚠️ **`?next=` is honoured only when it names a same-site path**, and that check is not
       * decoration: an open redirect that forwards to `https://evil.example` right after a genuine
       * sign-in is how a phishing page borrows the real one's credibility. `/join/<token>` is the
       * case this exists for — **the token has to survive the sign-in round trip**, and the address
       * bar is the only place it can survive a reload too.
       */
      await navigate(destination, {
        replace: true,
      });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="登录"
      footer={
        <>
          还没有账号？{" "}
          <Link className="font-medium text-brand-dark hover:underline" to="/register">
            使用邀请码注册
          </Link>
        </>
      }
    >
      {sessionRevoked ? (
        <Alert tone="info">登录状态已失效，请重新登录。</Alert>
      ) : null}

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

      <div className="text-center text-sm">
        <Link className="text-muted transition hover:text-ink" to="/recover">
          忘记密码
        </Link>
      </div>
    </AuthLayout>
  );
}
