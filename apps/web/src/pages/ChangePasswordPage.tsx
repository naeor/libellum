import { PASSWORD_MIN_LENGTH, changePasswordRequestSchema } from "@libellum/shared";
import { useState } from "react";
import { useNavigate } from "react-router";

import { Alert } from "../components/Alert.js";
import { Button } from "../components/Button.js";
import { Card } from "../components/Card.js";
import { InnerPage } from "../components/InnerPage.js";
import { TextField } from "../components/TextField.js";
import { apiFetch, errorMessage } from "../lib/api.js";

export function ChangePasswordPage(): React.JSX.Element {
  const navigate = useNavigate();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setDone(false);

    const parsed = changePasswordRequestSchema.safeParse({ currentPassword, newPassword });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "请检查填写的内容");
      return;
    }

    setBusy(true);
    try {
      await apiFetch("/auth/password", { method: "POST", body: parsed.data });
      setCurrentPassword("");
      setNewPassword("");
      setDone(true);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <InnerPage
      title="更改密码"
      subtitle="修改成功后，其它设备上的登录状态将立即失效。"
      onBack={() => void navigate("/")}
    >
      <Card>
        <form className="flex flex-col gap-5" onSubmit={(event) => void submit(event)}>
          {error ? <Alert>{error}</Alert> : null}
          {done ? <Alert tone="success">密码已更新。</Alert> : null}

          <TextField
            label="当前密码"
            type="password"
            autoComplete="current-password"
            autoFocus
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

          <Button type="submit" disabled={busy}>
            {busy ? "提交中…" : "确认修改"}
          </Button>
        </form>
      </Card>
    </InnerPage>
  );
}
