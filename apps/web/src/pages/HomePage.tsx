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
      <header>
        <p className="text-sm text-muted">Libellum</p>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{user.displayName}</h1>
      </header>

      <Card>
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
      </Card>

      <Card>
        <div className="flex flex-col gap-3">
          <Button variant="secondary" onClick={() => void navigate("/settings/password")}>
            更改密码
          </Button>
          <Button variant="secondary" onClick={() => void navigate("/settings/recovery-code")}>
            生成新的恢复码
          </Button>
        </div>
      </Card>

      <Button variant="danger" onClick={() => void logout()}>
        退出登录
      </Button>
    </main>
  );
}
