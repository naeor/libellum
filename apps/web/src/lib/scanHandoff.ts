/**
 * Handing the chosen screenshots from the recording cards to the recognition
 * screen.
 *
 * **Why a module and not a route state.** The owner asked for two fewer taps:
 * pressing 拍照 should open the image picker straight away and, once a picture
 * is chosen, go to recognition. That means the card owns the picker and the
 * screen does the work, so the chosen `File`s have to cross a navigation.
 *
 * They cannot go through the URL — a `File` is not serialisable, and the
 * alternative (an object URL) would put somebody's screenshot in their history.
 * They cannot go through router state either, because a `File` in history state
 * survives a back-navigation and would be *re-used*: go forward, go back, and
 * the same picture is recognised again. So they are handed over in memory, once,
 * and the handover is emptied as it is read.
 *
 * In memory is also the right lifetime for the other reason: screenshots are
 * discarded as soon as recognition finishes and nothing is ever stored. A
 * handover that outlives its read would be a leak of exactly the thing the
 * feature promises not to keep.
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
