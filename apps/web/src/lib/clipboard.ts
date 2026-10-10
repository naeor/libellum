/**
 * Put text on the clipboard, whichever way works.
 *
 * ⚠️ **The owner reported the clipboard coming out blank, and the obvious call is the one that
 * failed**: "不知道为什么复制到粘贴板后粘贴是一片空白."
 *
 * `navigator.clipboard.writeText()` is asynchronous, and **it needs the document to still hold
 * focus when the promise settles** — which is exactly what does not hold on a tablet where the
 * keyboard or the share sheet has just taken focus, or when the page is being served over a
 * LAN address the browser treats with suspicion. When it fails it rejects, and a `.then()` with
 * no `.catch()` turns that into silence and an empty clipboard. **The user sees "已复制" and
 * pastes nothing, which is worse than an error.**
 *
 * So three attempts, in order of how much they depend on the browser being modern:
 *
 *  1. **`execCommand("copy")` first, and synchronously.** It is deprecated and it is the most
 *     reliable thing available: it runs inside the click handler's own task, needs no permission
 *     prompt, and works in web views and in-secure-context edge cases where the modern API does
 *     not. **Deprecated is not the same as broken, and this is a case where the older interface
 *     has fewer preconditions**;
 *  2. **the async Clipboard API**, if the first produced nothing;
 *  3. **a visible textarea**, selected, so the user can copy by hand — the last resort, and it
 *     is only offered when the first two failed.
 *
 * **The caller is told which happened**, because "已复制" must be true when it is shown.
 */
export type CopyOutcome = "copied" | "manual" | "failed";

/** Try every mechanism available, cheapest and most reliable first. */
export async function copyText(text: string): Promise<CopyOutcome> {
  /**
   * The synchronous attempt.
   *
   * A textarea appended to the document, selected, and copied — all inside the caller's own
   * task, so no permission prompt and no focus change can intervene. `readOnly` is deliberately
   * **not** set: iOS refuses to select a read-only field in some versions, which is the exact
   * platform this is for.
   */
  if (typeof document !== "undefined") {
    try {
      const area = document.createElement("textarea");

      area.value = text;
      area.setAttribute("aria-hidden", "true");
      area.style.position = "fixed";
      area.style.top = "0";
      area.style.left = "0";
      area.style.width = "1px";
      area.style.height = "1px";
      area.style.padding = "0";
      area.style.border = "none";
      area.style.outline = "none";
      area.style.boxShadow = "none";
      area.style.background = "transparent";
      area.style.opacity = "0";

      document.body.appendChild(area);

      /**
       * ⚠️ **`setSelectionRange`, not just `select()`.**
       *
       * On iOS, `select()` on a textarea that has just been inserted often selects nothing,
       * and the copy then succeeds while putting an empty string on the clipboard — which is
       * precisely the symptom reported. `setSelectionRange(0, length)` is explicit about what
       * is being selected.
       */
      area.focus();
      area.setSelectionRange(0, text.length);

      const copied = document.execCommand("copy");

      document.body.removeChild(area);

      if (copied) return "copied";
    } catch {
      // Fall through to the next attempt.
    }
  }

  try {
    await navigator.clipboard.writeText(text);

    return "copied";
  } catch {
    /**
     * Both automatic routes are gone, so the text is offered for a manual copy.
     *
     * ⚠️ **Returned rather than thrown**, because the caller has something useful to do with
     * it: show the text selected in a box the user can copy from. A silent failure here is
     * what produced a "已复制" message over an empty clipboard.
     */
    return "manual";
  }
}
