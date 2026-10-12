import { useState } from "react";

import { errorMessage } from "../lib/api.js";
import {
  useDecideNotification,
  useMarkNotificationsRead,
  useNotifications,
  type NotificationView,
} from "../lib/queries.js";

/**
 * The bell, and the panel it opens.
 *
 * ⚠️ **The owner described this screen in detail, and the details are the design**:
 *
 * > *"在协作者页面顶部增加一个'提醒'按钮，用一个铃铛图形表示，点开后会进入提醒板块。
 * > 把这些需要他处理的内容都放到通知板块中……每个通知就像明细一样，在板块中占一个小矩形
 * > （显示部分简略信息，标题以及发送者和发送者留言（只显示前n个字）），下方有同意和拒绝两个按钮，
 * > 直接点击小矩形也可以进入信息-详情页面查看详情。有待处理信息时，提醒按钮右上角会出现小红点。"*
 *
 * So: a bell at the top, a red dot when something is waiting, one rectangle per notification with a
 * truncated message, **two buttons on the rectangle itself**, and the whole rectangle is also a way
 * in to the detail.
 *
 * ⚠️ **"我已看过" and "我已处理" are different states, and both are kept.** Opening the panel marks
 * things read (the dot clears), but a notification stays in the pending list until it is answered —
 * **clearing a dot must never look like answering a question.**
 */
export function NotificationBell(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const inbox = useNotifications();
  const markRead = useMarkNotificationsRead();

  const unread = inbox.data?.unreadCount ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm text-muted">提醒</h2>

        <button
          type="button"
          onClick={() => {
            setOpen((was) => {
              const next = !was;
              /**
               * ⚠️ **Opening it is what clears the dot**, and the request is fired and not awaited:
               * the panel must appear at once, and a failed "mark read" is not a reason to keep the
               * reader waiting. The next load reports the truth either way.
               */
              if (next && unread > 0) void markRead.mutateAsync().catch(() => undefined);
              return next;
            });
          }}
          aria-expanded={open}
          aria-label={unread > 0 ? `提醒，${String(unread)} 条未读` : "提醒"}
          className="relative flex h-10 w-10 items-center justify-center rounded-full border border-line bg-surface text-ink transition hover:bg-canvas"
        >
          <BellIcon />
          {unread > 0 ? (
            <span
              data-testid="notification-dot"
              className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-danger ring-2 ring-surface"
            />
          ) : null}
        </button>
      </div>

      {open ? <NotificationPanel /> : null}
    </div>
  );
}

function NotificationPanel(): React.JSX.Element {
  const inbox = useNotifications();
  const decide = useDecideNotification();
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  if (inbox.isPending) return <p className="text-sm text-muted">正在读取提醒……</p>;
  if (!inbox.isSuccess) return <p className="text-sm text-danger">提醒读取失败。</p>;

  const { notifications, pendingCount } = inbox.data;

  return (
    <div className="flex flex-col gap-3">
      {error !== null ? (
        <p role="alert" className="rounded-field bg-danger-soft px-4 py-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {notifications.length === 0 ? (
        <p className="rounded-card border border-line bg-surface px-5 py-4 text-sm text-muted">
          现在没有需要你处理的事情。
        </p>
      ) : null}

      {pendingCount > 0 ? (
        <p className="text-xs text-muted">
          有 {String(pendingCount)} 条等着你处理。不处理的话，七天后会自动失效。
        </p>
      ) : null}

      <ul className="flex flex-col gap-3">
        {notifications.map((notification) => (
          <li key={notification.id}>
            <NotificationCard
              notification={notification}
              expanded={expanded === notification.id}
              busy={decide.isPending}
              onToggle={() => {
                setExpanded((current) => (current === notification.id ? null : notification.id));
              }}
              onDecide={(decision) => {
                setError(null);
                void decide
                  .mutateAsync({ id: notification.id, decision })
                  .catch((caught: unknown) => {
                    setError(errorMessage(caught));
                  });
              }}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One notification: a rectangle with a summary, two buttons, and the full text behind a tap.
 *
 * ⚠️ **The two buttons are on the rectangle rather than behind the detail view**, which is what the
 * owner asked for: deciding is the common action, and making somebody open a card to find the
 * buttons would add a tap to the thing they came to do.
 */
function NotificationCard({
  notification,
  expanded,
  busy,
  onToggle,
  onDecide,
}: {
  readonly notification: NotificationView;
  readonly expanded: boolean;
  readonly busy: boolean;
  readonly onToggle: () => void;
  readonly onDecide: (decision: "accepted" | "declined") => void;
}): React.JSX.Element {
  const decided = notification.status !== "pending";

  return (
    <article className="overflow-hidden rounded-card border border-line bg-surface">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full flex-col gap-1 px-5 py-4 text-left"
      >
        <span className="flex items-center gap-2 text-sm text-ink">
          {titleOf(notification)}
          {statusBadge(notification)}
        </span>

        <span className="text-xs text-muted">
          {notification.sender.displayName}（{notification.sender.accountNumber}）
        </span>

        {notification.message === null ? null : (
          <span className="text-xs leading-relaxed text-muted">
            {expanded ? notification.message : truncate(notification.message, 40)}
          </span>
        )}
      </button>

      {decided ? (
        <p className="border-t border-line px-5 py-3 text-xs text-muted">
          {notification.status === "accepted" ? "你已经同意了这条邀请。" : "你已经拒绝了这条邀请。"}
        </p>
      ) : (
        <div className="flex gap-3 border-t border-line px-5 py-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              onDecide("accepted");
            }}
            className="flex-1 rounded-field bg-brand px-4 py-2 text-sm text-white transition hover:bg-brand-dark disabled:opacity-45"
          >
            同意
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              onDecide("declined");
            }}
            className="flex-1 rounded-field bg-canvas px-4 py-2 text-sm text-muted transition hover:text-ink disabled:opacity-45"
          >
            拒绝
          </button>
        </div>
      )}
    </article>
  );
}

/** The heading on one card. */
function titleOf(notification: NotificationView): string {
  if (notification.kind === "collaborator_request") return "协作者申请";
  if (notification.kind === "referral_reminder") return "邀请码提醒";
  return notification.book === null ? "账本邀请" : `邀请你加入「${notification.book.name}」`;
}

/** A decided card says so; a pending one says nothing, because the buttons already say it. */
function statusBadge(notification: NotificationView): React.JSX.Element | null {
  if (notification.status === "accepted") {
    return <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] text-brand-dark">已同意</span>;
  }

  if (notification.status === "declined") {
    return <span className="rounded-full bg-canvas px-2 py-0.5 text-[11px] text-muted">已拒绝</span>;
  }

  return null;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function BellIcon(): React.JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 13 6 9Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 18a2 2 0 0 0 4 0" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
