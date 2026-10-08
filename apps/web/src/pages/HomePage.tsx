import { useNavigate } from "react-router";

import { useAuth } from "../auth/AuthProvider.js";
import { Button } from "../components/Button.js";
import { Card } from "../components/Card.js";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function HomePage(): React.JSX.Element {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  if (!user) return <></>;

  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-col gap-5 px-5 py-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm text-muted">Libellum</p>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{user.displayName}</h1>
        </div>
        <Button
          variant="ghost"
          fullWidth={false}
          className="px-3 py-2 text-sm"
          onClick={() => void logout()}
        >
          退出登录
        </Button>
      </header>

      <Card>
        <h2 className="text-sm font-medium text-muted">账号信息</h2>

        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
          <dt className="text-muted">账号编号</dt>
          <dd className="text-right font-mono tracking-wide text-ink">{user.accountNumber}</dd>

          <dt className="text-muted">用户名</dt>
          <dd className="text-right text-ink">{user.username}</dd>

          <dt className="text-muted">显示名称</dt>
          <dd className="text-right text-ink">{user.displayName}</dd>

          <dt className="text-muted">注册时间</dt>
          <dd className="text-right text-ink">{formatDateTime(user.createdAt)}</dd>
        </dl>

        <p className="mt-4 text-xs leading-relaxed text-muted">
          账号编号用于识别本账号，可以安全地提供给他人；恢复码必须保密。
        </p>
      </Card>

      <Card>
        <h2 className="text-sm font-medium text-muted">安全</h2>
        <div className="mt-4 flex flex-col gap-3">
          <Button variant="secondary" onClick={() => void navigate("/settings/password")}>
            更改密码
          </Button>
          <Button variant="secondary" onClick={() => void navigate("/settings/recovery-code")}>
            生成新的恢复码
          </Button>
        </div>
      </Card>
    </main>
  );
}
