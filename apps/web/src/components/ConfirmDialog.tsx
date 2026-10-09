import { useEffect, useRef } from "react";

/**
 * Confirmation before anything is destroyed.
 *
 * Three decisions worth stating:
 *  * **The safe choice gets focus.** A stray Enter or an accidental double-tap
 *    must never delete something; the user has to move to the destructive
 *    button deliberately.
 *  * **The consequences are listed explicitly**, not implied by the word
 *    "delete". If data cannot be restored by the user, the dialog says so in
 *    those words.
 *  * Nothing is announced as recoverable unless it really is: archiving says
 *    it can be undone, deleting does not.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  consequences = [],
  confirmLabel = "确认",
  cancelLabel = "取消",
  tone = "danger",
  busy = false,
  onConfirm,
  onCancel,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly consequences?: readonly string[];
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly tone?: "danger" | "default";
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): React.JSX.Element | null {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    cancelRef.current?.focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }

      // Two focusable controls: keep Tab cycling between them so focus cannot
      // wander onto the page behind the dialog.
      if (event.key === "Tab") {
        event.preventDefault();
        if (document.activeElement === cancelRef.current) confirmRef.current?.focus();
        else cancelRef.current?.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/25 px-5 backdrop-blur-[2px]"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-description"
        className="w-full max-w-sm rounded-card border border-line bg-surface p-6 shadow-lg"
      >
        <h2 id="confirm-title" className="text-base font-semibold text-ink">
          {title}
        </h2>
        <p id="confirm-description" className="mt-2 text-sm leading-relaxed text-muted">
          {description}
        </p>

        {consequences.length > 0 ? (
          <ul className="mt-4 flex flex-col gap-1.5 rounded-field bg-canvas px-4 py-3 text-xs leading-relaxed text-muted">
            {consequences.map((item) => (
              <li key={item} className="flex gap-2">
                <span aria-hidden="true">·</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-6 flex gap-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-field bg-brand-soft px-4 py-3 text-[15px] font-medium text-brand-dark transition hover:bg-brand-soft/70"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`flex-1 rounded-field px-4 py-3 text-[15px] font-medium text-white transition disabled:opacity-50 ${
              tone === "danger" ? "bg-danger hover:bg-danger-dark" : "bg-brand hover:bg-brand-dark"
            }`}
          >
            {busy ? "处理中…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
