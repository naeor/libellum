import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "../components/Button.js";
import { copyText } from "../lib/clipboard.js";

/**
 * A button that copies something and says so.
 *
 * ⚠️ **Extracted because the owner asked for one behaviour in two places — and because the two
 * places had drifted.**
 *
 * On the version screen the copy worked. On the download manager's diagnostics screen it did
 * nothing: same helper, same text, but the click handler had been written separately and its
 * outcome was never read, so the label never changed and no manual fallback was ever offered.
 * **A feature implemented twice is a feature that works in one of the two places**, and which
 * one is decided by luck.
 *
 * **The feedback is the part he specified**: "改成点了之后先短暂变浅闪烁一下，然后文本变成已复制
 * 到剪切版." A copy gives no visible result of its own — nothing moves, nothing appears — so
 * without an acknowledgement the honest reading of a silent button is that it did nothing. The
 * flash answers "did the press register" immediately, and the label then answers "did it work".
 */
export function CopyButton({
  text,
  label = "复制",
  copiedLabel = "已复制到剪贴板",
  onOutcome,
  variant = "primary",
}: {
  readonly text: string;
  readonly label?: string;
  readonly copiedLabel?: string;
  /** Told what happened, so a screen can offer the manual fallback when it is needed. */
  readonly onOutcome?: (outcome: "copied" | "manual" | "failed") => void;
  readonly variant?: "primary" | "secondary" | "danger" | "ghost";
}): React.JSX.Element {
  const [phase, setPhase] = useState<"idle" | "flash" | "copied">("idle");
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
     * Copying may be asynchronous and may take a moment; the flash is about the *press*, and
     * acknowledging a press should not wait on the work it started. If the copy then fails, the
     * label corrects itself and the fallback appears — but the user already knows the tap landed.
     */
    setPhase("flash");

    void copyText(text).then((outcome) => {
      onOutcome?.(outcome);

      if (outcome === "copied") {
        setPhase("copied");
        timers.current.push(
          window.setTimeout(() => {
            setPhase("idle");
          }, 2_500),
        );
      } else {
        // Not copied, so not claimed: the label stays as it was and the caller explains why.
        setPhase("idle");
      }
    });
  }, [text, onOutcome]);

  return (
    <Button
      variant={variant}
      onClick={press}
      /**
       * The dimming is a class rather than a state in the label, so the button keeps its size
       * and position while it changes — a control that moves under a thumb is a control that
       * gets pressed twice.
       */
      className={`transition-opacity duration-200 ${phase === "flash" ? "opacity-40" : "opacity-100"}`}
    >
      {phase === "copied" ? copiedLabel : label}
    </Button>
  );
}
