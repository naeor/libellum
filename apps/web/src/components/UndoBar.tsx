import { useEffect } from "react";

/**
 * A short-lived bar offering to undo the thing that just happened.
 *
 * This is the *second* line of defence. The first is the confirmation dialog
 * before a destructive action; this catches the case where the user confirmed
 * without reading. It is deliberately short-lived — an undo that lingers
 * becomes clutter.
 */
export function UndoBar({
  message,
  actionLabel = "撤销",
  durationMs = 5000,
  onAction,
  onDismiss,
}: {
  readonly message: string;
  readonly actionLabel?: string;
  readonly durationMs?: number;
  readonly onAction: () => void;
  readonly onDismiss: () => void;
}): React.JSX.Element {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, durationMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [durationMs, onDismiss, message]);

  return (
    <div className="fixed inset-x-0 bottom-28 z-50 flex justify-center px-5">
      <div className="flex w-full max-w-md items-center justify-between gap-4 rounded-field bg-ink px-4 py-3 text-sm text-white shadow-lg">
        <span>{message}</span>
        <button
          type="button"
          onClick={onAction}
          className="shrink-0 font-medium text-brand-soft transition hover:text-white"
        >
          {actionLabel}
        </button>
      </div>
    </div>
  );
}
