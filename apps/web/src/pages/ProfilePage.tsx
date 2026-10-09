import { InnerPage } from "../components/Layouts.js";
import { useAuth } from "../auth/AuthProvider.js";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Who you are, as the server knows it.
 *
 * Split out of the account screen on the owner's suggestion. The account
 * screen answers "where do I go"; this answers "what does the system know about
 * me", and those are different questions — mixing them is how the account
 * number ended up printed twice on one page.
 *
 * Nothing here is editable yet. Fields that look editable but are not would be
 * worse than fields that plainly are not, so the page states what each value is
 * for and leaves it at that until editing exists.
 */
export function ProfilePage(): React.JSX.Element {
  const { user } = useAuth();

  if (!user) return <></>;

  return (
    <InnerPage title="个人资料" subtitle="这些信息用于标识你的账号。" backTo="/me">
      <section className="rounded-card border border-line bg-surface p-6">
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-4 text-sm">
          <dt className="text-muted">昵称</dt>
          <dd className="text-right text-ink">{user.displayName}</dd>

          <dt className="text-muted">用户名</dt>
          <dd className="text-right text-ink">{user.username}</dd>

          <dt className="text-muted">账号编号</dt>
          <dd className="text-right font-mono tracking-wide text-ink">{user.accountNumber}</dd>

          <dt className="text-muted">注册时间</dt>
          <dd className="text-right text-ink">{formatDateTime(user.createdAt)}</dd>
        </dl>

        <p className="mt-6 border-t border-line pt-4 text-xs leading-relaxed text-muted">
          用户名和账号编号可安全地分享给他人，以便对方将你添加为协作者。
          <br />
          请勿向任何人透露恢复码。恢复码应被妥善保管。
        </p>
      </section>

      <section className="rounded-card border border-line bg-surface p-6">
        <h2 className="text-sm font-medium text-ink">各项的作用</h2>
        <dl className="mt-3 flex flex-col gap-3 text-xs leading-relaxed text-muted">
          <div>
            <dt className="text-ink">昵称</dt>
            <dd className="mt-0.5">应用内显示的名字，可以与其他人重复。</dd>
          </div>
          <div>
            <dt className="text-ink">用户名</dt>
            <dd className="mt-0.5">登录时使用，全站唯一。协作者可以通过它找到你。</dd>
          </div>
          <div>
            <dt className="text-ink">账号编号</dt>
            <dd className="mt-0.5">
              八位数字，与用户名等效，但更容易抄写和读出。协作者可以用它找到你。
            </dd>
          </div>
          <div>
            <dt className="text-ink">恢复码</dt>
            <dd className="mt-0.5">
              忘记密码时唯一的找回方式。它只在你注册时显示一次，服务器只保存它的哈希值，无法再取回原文。
            </dd>
          </div>
        </dl>
      </section>
    </InnerPage>
  );
}
