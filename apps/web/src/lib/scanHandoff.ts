/**
 * Handing things from the recording controls to the screens that use them.
 *
 * **Why a module and not route state.**
 *
 * Photographs: the owner asked for two fewer taps — pressing 拍照 should open the
 * image picker straight away and, once a picture is chosen, go to recognition.
 * That means the card owns the picker and the screen does the work, so the chosen
 * `File`s cross a navigation.
 *
 * A transcript: the voice screen records, sends, reads the answer, and only then
 * knows what to put in the form. Passing the text through the URL would work
 * today and would put somebody's sentence in their browser history, where it
 * outlives the entry they decided not to save.
 *
 * `File`s cannot go through the URL at all, and not through history state either:
 * a `File` in history state survives a back-navigation and would be **re-used**,
 * so forward, back, and the same picture is recognised again.
 *
 * So both are handed over **in memory, once**, and the handover is emptied as it
 * is read. In memory is also the right lifetime for the promise these features
 * make — screenshots and recordings are discarded once read.
 */

let pending: File[] = [];

/** Put the chosen files where the recognition screen will find them. */
export function handOverForScan(files: readonly File[]): void {
  pending = [...files];
}

/**
 * Take the files, leaving nothing behind.
 *
 * Reading clears the handover, so a second read — a remount, a back-navigation,
 * a refresh — finds nothing and the screen behaves as if it had been opened
 * directly. That is what makes "go back and forward again" safe.
 */
export function takeScanHandover(): File[] {
  const files = pending;
  pending = [];

  return files;
}

/** What the voice screen hands to its review form. */
export interface SpokenDraftHandover {
  /** The sentence as heard, already edited by the user if they changed it. */
  readonly text: string;
  /** Digits as spoken, or null when no amount was heard. */
  readonly amount: string | null;
  readonly kind: "expense" | "income";
}

let pendingSpoken: SpokenDraftHandover | null = null;

/** Put a transcript where the review screen will find it. */
export function handOverSpoken(draft: SpokenDraftHandover): void {
  pendingSpoken = draft;
}

/**
 * Take the transcript, leaving nothing behind.
 *
 * `null` means the screen was opened directly — a bookmark, a refresh, a back
 * press. The review screen then says so and points at the recorder rather than
 * showing an empty form the user has to work out is empty.
 */
export function takeSpokenHandover(): SpokenDraftHandover | null {
  const draft = pendingSpoken;
  pendingSpoken = null;

  return draft;
}
