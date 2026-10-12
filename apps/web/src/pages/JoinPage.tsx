import { useState } from "react";
import { useNavigate, useParams } from "react-router";

import { Button } from "../components/Button.js";
import { InnerPage } from "../components/Layouts.js";
import { SkeletonRows } from "../components/States.js";
import { errorMessage } from "../lib/api.js";
import { useJoinViaShareLink, useShareLinkPreview } from "../lib/queries.js";

/**
 * What happens when somebody opens a share link.
 *
 * ⚠️ **Nothing happens until they press the button, and that is the design.**
 *
 * The owner's rule: *"/join/:token 未登录先保存状态，不自动加入；登录后弹窗确认."* So this screen
 * **reads** the link, says **which ledger and what permission**, and waits. A version that joined on
 * open would add people to ledgers from a stray tap on a link in a chat window — and the person who
 * tapped it would have no idea which ledger they had just been added to.
 *
 * ⚠️ **The un-signed-in half is handled by the router, not here.** A visitor with no session is sent
 * to sign in first and comes back to this same URL — so the token survives in the address bar rather
 * than in a state variable that a reload would lose. **A token kept in memory is a token lost by the
 * first page refresh**, and signing in always involves one.
 */
export function JoinPage(): React.JSX.Element {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const preview = useShareLinkPreview(token ?? null);
  const join = useJoinViaShareLink();
  const [error, setError] = useState<string | null>(null);

  if (preview.isPending) {
    return (
      <InnerPage title="加入账本" subtitle="正在读取这个邀请链接。" backTo="/">
        <SkeletonRows rows={2} />
      </InnerPage>
    );
  }

  if (preview.isError) {
    return (
      <InnerPage title="加入账本" subtitle="这个链接不能用了。" backTo="/">
        <div className="rounded-card border border-line bg-surface p-5">
          <p className="text-sm leading-relaxed text-muted">
            这个分享链接**无效或已被撤销**。请让邀请你的人重新生成一条。
          </p>
          <p className="mt-4 text-xs text-muted">
            （链接只能被生成它的那个人撤销。撤销之后，手上的旧链接都会失效。）
          </p>
        </div>
      </InnerPage>
    );
  }

  const data = preview.data;

  if (data.alreadyMember) {
    return (
      <InnerPage title="加入账本" subtitle="你已经在这本账里了。" backTo="/">
        <div className="rounded-card border border-line bg-surface p-5">
          <p className="text-sm text-ink">「{data.bookName}」</p>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            你已经在这本账里，不需要再加入一次。
          </p>
          <div className="mt-4">
            <Button
              onClick={() => {
                navigate("/start");
              }}
            >
              去我的账本
            </Button>
          </div>
        </div>
      </InnerPage>
    );
  }

  return (
    <InnerPage title="加入账本" subtitle="请确认之后才会加入。" backTo="/">
      {error !== null ? (
        <p role="alert" className="mb-4 rounded-field bg-danger-soft px-4 py-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div className="rounded-card border border-line bg-surface p-5">
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-3 text-sm">
          <dt className="text-muted">账本</dt>
          <dd className="text-right text-ink">{data.bookName}</dd>

          <dt className="text-muted">账本编号</dt>
          <dd className="text-right font-mono text-ink">{data.bookNumber ?? "（未分配）"}</dd>

          <dt className="text-muted">邀请人</dt>
          <dd className="text-right text-ink">{data.createdByName}</dd>

          <dt className="text-muted">你的权限</dt>
          <dd className="text-right text-ink">{data.role === "editor" ? "可编辑" : "仅查看"}</dd>
        </dl>

        <p className="mt-5 border-t border-line pt-4 text-xs leading-relaxed text-muted">
          {data.role === "editor"
            ? "加入后你可以记帐、改帐目。"
            : "加入后你可以看到这本账的全部账目，但不能修改。"}
          {" "}加入之前什么都不会发生。
        </p>

        <div className="mt-5 flex flex-col gap-3">
          <Button
            disabled={join.isPending}
            onClick={() => {
              setError(null);
              if (token === undefined) return;

              void join
                .mutateAsync(token)
                .then(() => {
                  navigate("/start");
                })
                .catch((caught: unknown) => {
                  setError(errorMessage(caught));
                });
            }}
          >
            {join.isPending ? "正在加入……" : "确认加入"}
          </Button>

          <Button
            variant="secondary"
            onClick={() => {
              navigate("/");
            }}
          >
            先不加入
          </Button>
        </div>
      </div>
    </InnerPage>
  );
}
