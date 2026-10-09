import { useState } from "react";
import { useNavigate } from "react-router";

import { Alert } from "../components/Alert.js";
import { Button } from "../components/Button.js";
import { Card } from "../components/Card.js";
import { InnerPage } from "../components/Layouts.js";
import { RecoveryCodeCard } from "../components/RecoveryCodeCard.js";
import { TextField } from "../components/TextField.js";
import { apiFetch, errorMessage } from "../lib/api.js";

export function RegenerateRecoveryCodePage(): React.JSX.Element {
  const navigate = useNavigate();

  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);

    if (password.length === 0) {
      setError("请输入当前密码。");
      return;
    }

    setBusy(true);
    try {
      const response = await apiFetch<{ recoveryCode: string }>("/auth/recovery-code", {
        method: "POST",
        body: { password },
      });
      setIssuedCode(response.recoveryCode);
      setPassword("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (issuedCode) {
    return (
      <InnerPage title="新的恢复码" subtitle="请立即保存。" onBack={() => void navigate("/settings")}>
        <RecoveryCodeCard code={issuedCode} onContinue={() => void navigate("/settings")} />
      </InnerPage>
    );
  }

  return (
    <InnerPage
      title="生成新的恢复码"
      subtitle="生成后，原有的恢复码将立即失效。"
      onBack={() => void navigate("/settings")}
    >
      <Card>
        <form className="flex flex-col gap-5" onSubmit={(event) => void submit(event)}>
          {error ? <Alert>{error}</Alert> : null}

          <p className="text-sm leading-relaxed text-muted">
            恢复码用于在忘记密码时重置密码，仅在生成时显示一次。请仅在原恢复码遗失或可能泄露时重新生成。
          </p>

          <TextField
            label="当前密码"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />

          <Button type="submit" disabled={busy}>
            {busy ? "生成中…" : "确认生成"}
          </Button>
        </form>
      </Card>
    </InnerPage>
  );
}
