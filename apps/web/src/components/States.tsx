/**
 * What a screen shows before it has anything to show.
 *
 * An empty list is the first thing a new user meets, so it gets an
 * explanation and a way forward rather than blank space.
 */
export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
}: {
  readonly title: string;
  readonly description: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <p className="text-base font-medium text-ink">{title}</p>
      <p className="max-w-xs text-sm leading-relaxed text-muted">{description}</p>
      {actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="mt-2 rounded-field bg-brand px-6 py-2.5 text-sm font-medium text-white transition hover:bg-brand-dark"
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

/** Placeholder rows while the first page loads — never a blank screen. */
export function SkeletonRows({ rows = 5 }: { readonly rows?: number }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 px-5 py-4" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3">
          <div className="size-9 shrink-0 animate-pulse rounded-full bg-line" />
          <div className="flex flex-1 flex-col gap-2">
            <div className="h-3.5 w-2/5 animate-pulse rounded bg-line" />
            <div className="h-3 w-1/4 animate-pulse rounded bg-line" />
          </div>
          <div className="h-3.5 w-16 animate-pulse rounded bg-line" />
        </div>
      ))}
    </div>
  );
}

/** A failed load must offer a way out, not just a message. */
export function ErrorState({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <p className="text-base font-medium text-ink">加载失败</p>
      <p className="max-w-xs text-sm leading-relaxed text-muted">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 rounded-field bg-brand-soft px-6 py-2.5 text-sm font-medium text-brand-dark transition hover:bg-brand-soft/70"
      >
        重试
      </button>
    </div>
  );
}
