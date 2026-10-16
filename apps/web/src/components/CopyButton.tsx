import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "../components/Button.js";
import { copyText } from "../lib/clipboard.js";

/**
 * Copy something, and always leave the text where it can be reached.
 *
 * ⚠️ **Extracted because the owner asked for one behaviour in two places — and because the two
 * places had drifted.**
 *
 * On the version screen the copy worked. On the diagnostics screen it did not: same helper, same
 * text, but the click handler had been written separately and its outcome was never read. **A
 * feature implemented twice is a feature that works in one of the two places**, and which one is
 * decided by luck.
 *
 * ⚠️ **And it now renders the text itself, always.**
 *
 * Two attempts at detecting "did the copy work" have been made, and the tablet produced a third
 * answer: the buttons work on one screen and not another with identical code. **That is a signal
 * to stop detecting and start guaranteeing.** Whatever the clipboard does, the text is on screen,
 * selectable, screenshot-able — so the goal is reachable without the clipboard at all, and the
 * button is a convenience rather than the only way through.
 *
 * **The feedback is the order he asked for**: "先短暂变浅闪烁一下，然后文本变成已复制到剪切版."
 * The flash answers "did the press land", immediately; the label answers "did it work", when it
 * has. A copy produces no visible result of its own, so a silent button's only honest reading is
 * that it did nothing.
 */
export function CopyButton({
  text,
  label = "复制",
  copiedLabel = "已复制到剪贴板",
  rows = 8,
  variant = "primary",
  /** Shown above the text box. Says what the text is for. */
  hint,
}: {
  readonly text: string;
  readonly label?: string;
  readonly copiedLabel?: string;
  readonly rows?: number;
  readonly variant?: "primary" | "secondary" | "danger" | "ghost";
  readonly hint?: string;
}): React.JSX.Element {
  const [phase, setPhase] = useState<"idle" | "flash" | "copied" | "manual">("idle");
  const timers = useRef<number[]>([]);

  // A screen that unmounts mid-flash must not leave timers behind.
  useEffect(
    () => () => {
      for (const timer of timers.current) window.clearTimeout(timer);
    },
    [],
  );

  const press = useCallback(() => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current = [];

    /**
     * ⚠️ **The flash starts before the copy is attempted, and that is deliberate.**
     *
     * Copying may be asynchronous; the flash is about the *press*, and acknowledging a press
     * should not wait on the work it started. If the copy then fails, the label corrects itself —
     * but the user already knows the tap landed.
     */
    setPhase("flash");

    void copyText(text).then((outcome) => {
      if (outcome === "copied") {
        setPhase("copied");
        timers.current.push(
          window.setTimeout(() => {
            setPhase("idle");
          }, 2_500),
        );

        return;
      }

      /**
       * Not copied, so not claimed. The text box is already on screen — this only points at it.
       */
      setPhase("manual");
    });
  }, [text]);

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant={variant}
        onClick={press}
        /**
         * The dimming is an opacity class rather than a label change, so the button keeps its size
         * and position — a control that moves under a thumb gets pressed twice.
         */
        className={`transition-opacity duration-200 ${phase === "flash" ? "opacity-40" : "opacity-100"}`}
      >
        {phase === "copied" ? copiedLabel : label}
      </Button>

      {phase === "manual" ? (
        <p className="text-center text-helper-relaxed text-muted">
          无法自动复制。请长按下方内容复制，或保存截图。
        </p>
      ) : null}

      {hint === undefined ? null : <p className="text-helper text-muted">{hint}</p>}

      {/*
        ⚠️ **Always rendered, not only on failure.**
        
        Two rounds were spent trying to detect when the clipboard would fail, and the tablet
        answered differently on two screens running identical code. **A fallback that has to
        predict the failure is a fallback that can be wrong**; one that is always present cannot.
        It also means the text can be screenshotted, which works everywhere.
      */}
      <textarea
        readOnly
        value={text}
        rows={rows}
        onFocus={(event) => {
          event.currentTarget.select();
        }}
        className="w-full rounded-field border border-line bg-surface px-3 py-2 font-mono text-[10px] leading-relaxed text-ink"
      />
    </div>
  );
}
