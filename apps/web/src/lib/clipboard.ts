/**
 * Put text on the clipboard, whichever way works.
 *
 * ⚠️ **Two rounds were spent on this because the failure was silent and then partial.**
 *
 * Round one: `navigator.clipboard.writeText()` with a `.then()` and no `.catch()`. It needs the
 * document to still hold focus when the promise settles — which is exactly what fails on a tablet
 * whose keyboard has just taken focus — so it rejected, the handler never ran, and the screen said
 * 已复制 over an empty clipboard. **Telling somebody something untrue is worse than an error.**
 *
 * Round two added a synchronous `execCommand("copy")` first, which then worked on one screen and
 * not another with **identical code**. The difference had to be somewhere the code was not
 * looking, so this version stops trying to be clever about detection and makes the text **always
 * reachable**: the copy is attempted, and the text is on screen either way.
 *
 * ⚠️ **The synchronous attempt is first, and "deprecated" is not a reason to drop it.** It runs
 * inside the click handler's own task, needs no permission prompt, and does not care where focus
 * has been — none of which is true of the modern API. **An older interface with fewer
 * preconditions is the better tool when the preconditions are what keeps failing.**
 */

export type CopyOutcome = "copied" | "manual" | "failed";

/** Try every mechanism available, cheapest and most reliable first. */
export async function copyText(text: string): Promise<CopyOutcome> {
  if (typeof document === "undefined") return "manual";

  /**
   * ⚠️ **The scratch element is created, used and removed inside this one call — and it is
   * deliberately visible to the layout engine.**
   *
   * The previous version made it 1×1 px with `opacity: 0`. On iOS that is a textarea the browser
   * may decide is not really on the page, and `execCommand("copy")` then "succeeds" with nothing
   * on the clipboard — which is the reported symptom exactly. **Being invisible was the bug.**
   *
   * So it is off-screen instead: full size, present in the layout, positioned outside the
   * viewport where the user never sees it. `transform` is avoided because it creates a containing
   * block that can interfere with selection on some engines.
   */
  let area: HTMLTextAreaElement | null = null;
  const previousFocus = document.activeElement;

  try {
    area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("aria-hidden", "true");
    area.setAttribute("tabindex", "-1");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "-9999px";
    area.style.width = "2em";
    area.style.height = "2em";
    area.style.padding = "0";
    area.style.border = "none";
    area.style.outline = "none";
    area.style.boxShadow = "none";
    area.style.background = "transparent";
    area.style.fontSize = "12pt";

    document.body.appendChild(area);

    /**
     * ⚠️ **`setSelectionRange`, not `select()`.**
     *
     * On iOS, `select()` on a textarea that has just been inserted frequently selects nothing,
     * and the copy then succeeds while putting an empty string on the clipboard. Being explicit
     * about the range is the difference between "it ran" and "it worked".
     */
    area.focus();
    area.setSelectionRange(0, text.length);

    if (document.execCommand("copy")) return "copied";
  } catch {
    // Fall through to the modern API.
  } finally {
    /**
     * ⚠️ **Removed and focus restored in a `finally`.**
     *
     * The previous version removed the element only on the success path, so a throw left an
     * off-screen focused textarea in the document for the rest of the session — and **a second
     * press then copied from the wrong place.** Focus is put back for the same reason: the user
     * pressed a button, and they should still be where they were.
     */
    area?.remove();

    if (previousFocus instanceof HTMLElement) previousFocus.focus();
  }

  try {
    await navigator.clipboard.writeText(text);

    return "copied";
  } catch {
    /**
     * Both automatic routes are gone.
     *
     * ⚠️ **Returned rather than thrown**, because the caller has something useful to do with it —
     * and because a silent failure here is what produced "已复制" over an empty clipboard. The
     * caller shows the text; **the text being on screen is the fallback that cannot fail.**
     */
    return "manual";
  }
}
