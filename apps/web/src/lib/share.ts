/**
 * Getting a file out of the app and into the user's hands.
 *
 * The owner's observation is the whole design brief: **"on an iPhone,
 * downloading something and sharing something are basically the same act."**
 * iOS Safari has no downloads drawer — a file either goes into the share sheet —
 * where 存储到文件, AirDrop and the other apps live — or it goes nowhere.
 *
 * So: share when the platform can share files, download when it cannot, and
 * **fall back to downloading when sharing throws**, because a share sheet the
 * user cancels is not an error and a share that fails must not leave them with
 * nothing.
 *
 * Three rules, each earning its place:
 *
 *  * **Detect, never assume.** `navigator.canShare({ files })` is the only
 *    honest test; a user-agent check would be wrong on iPadOS, which reports
 *    itself as a Mac.
 *  * **A cancelled share is not a failure.** `AbortError` means the user changed
 *    their mind, and the caller must not show them an error for it.
 *  * **Both paths report back.** A silent success is indistinguishable from a
 *    button that does nothing.
 */

export interface ShareOutcome {
  readonly method: "share" | "download";
  /** True when the user dismissed the share sheet themselves. */
  readonly cancelled: boolean;
}

/**
 * Bytes into a `File`.
 *
 * Bytes rather than a string, and never base64 on the way here: the export
 * answers with the file as its body, so this is the first representation the app
 * ever holds. Base64 in the middle would cost a third more memory and matter
 * nothing.
 */
export function toFile(fileName: string, mimeType: string, bytes: Uint8Array): File {
  return new File([bytes as BlobPart], fileName, { type: mimeType });
}

/** Can this browser hand a file to the system share sheet? */
export function canShareFiles(file: File): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [file] })
  );
}

/**
 * Put the file in the user's hands, by whichever route this platform has.
 *
 * Returns how it happened, so the caller can say so. Throws only when both
 * routes failed, which is the one case where the user has nothing and needs to
 * be told.
 */
export async function deliverFile(
  fileName: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<ShareOutcome> {
  const file = toFile(fileName, mimeType, bytes);

  if (canShareFiles(file)) {
    try {
      await navigator.share({ files: [file], title: fileName });
      return { method: "share", cancelled: false };
    } catch (error) {
      // Dismissing the sheet rejects too, with AbortError. That is a choice, not
      // a failure: report it and do not fall back, or the user who deliberately
      // closed the sheet gets a download they did not ask for.
      if (error instanceof DOMException && error.name === "AbortError") {
        return { method: "share", cancelled: true };
      }
      // Anything else — a browser that advertises sharing and then refuses —
      // falls through to the download below. Doing nothing would leave the user
      // holding a button that appears broken.
    }
  }

  downloadFile(file);
  return { method: "download", cancelled: false };
}

/** The ordinary route: an object URL and a link the browser saves. */
function downloadFile(file: File): void {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  // Revoked on a later tick: revoking synchronously can cancel the download in
  // some browsers before it has read the blob. Plain `setTimeout` rather than
  // `window.setTimeout` so the function is testable without a DOM.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
}
