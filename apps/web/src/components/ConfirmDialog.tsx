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
  children,
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
  /**
   * ⚠️ **Optional fields between the consequences and the buttons** (added for S13's console).
   *
   * A sensitive operation needs a reason and a second password *inside* the dialog — putting
   * them on the page behind it would let the confirmation describe one action while the form
   * collected input for another. Optional, so every existing caller is unchanged.
   *
   * ⚠️ **They were declared here and never rendered until 1.13.02.** The three S13 dialogs
   * (作废邀请码 / 停用账户 / 恢复账户) all pass their reason and password fields as children,
   * and the dialog dropped them — the confirmation appeared with no way to enter either, so
   * the only possible outcome was the validation message "需要填写原因并输入你的密码".
   * A prop that callers rely on must be rendered; the type alone is not a feature.
   */
  readonly children?: React.ReactNode;
}): React.JSX.Element | null {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  /**
   * ⚠️ **Focus the safe choice once, when the dialog opens.**
   *
   * This is a separate effect from the key listener on purpose. `onCancel` is usually an
   * inline arrow, so it is a new function on every parent render — and while the two
   * effects were combined, typing one character into a child input re-rendered the parent,
   * changed `onCancel`, re-ran the effect and **pulled focus back to 取消**. The field
   * could then only ever hold one character. Focus is a one-time event, not a side effect
   * of the parent re-rendering.
   */
  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }

      /**
       * ⚠️ **Focus stays inside the dialog, but it must reach every control in it.**
       *
       * This used to cycle between exactly the two buttons, which was true only while the
       * dialog had exactly two controls. Since it can carry an input and a password field,
       * a two-element cycle would make them unreachable by keyboard — and keep Tab on the
       * buttons while a sighted user saw fields above them.
       */
      if (event.key === "Tab") {
        const focusable = Array.from(
          dialogRef.current?.querySelectorAll<HTMLElement>(
            "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]",
          ) ?? [],
        ).filter((element) => element.offsetParent !== null);

        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (first === undefined || last === undefined) return;

        const active = document.activeElement;
        if (!dialogRef.current?.contains(active)) {
          event.preventDefault();
          first.focus();
          return;
        }

        if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        }
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay-soft px-5 backdrop-blur-[2px]"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-description"
        className="w-full max-w-sm rounded-card border border-line bg-surface p-6 shadow-lg"
      >
        <h2 id="confirm-title" className="text-base font-semibold text-ink">
          {title}
        </h2>
        <p id="confirm-description" className="mt-2 text-body-relaxed text-muted">
          {description}
        </p>

        {consequences.length > 0 ? (
          <ul className="mt-4 flex flex-col gap-1.5 rounded-field bg-canvas px-4 py-3 text-helper-relaxed text-muted">
            {consequences.map((item) => (
              <li key={item} className="flex gap-2">
                <span aria-hidden="true">·</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {/* ⚠️ Rendered here, between what will happen and the buttons that do it. */}
        {children}

        <div className="mt-6 flex gap-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-field bg-brand-soft px-4 py-3 text-button-lg font-medium text-brand-dark transition hover:bg-brand-soft/70"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`flex-1 rounded-field px-4 py-3 text-button-lg font-medium text-white transition disabled:opacity-45 ${
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
