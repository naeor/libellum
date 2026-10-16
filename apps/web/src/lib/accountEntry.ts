/** Startup decisions, independent of the ocean's animation and of the last visited tab. */
export function entryBookId(
  lastBookId: string | null,
  accessible: readonly { readonly id: string }[],
): string | null {
  return accessible.find((book) => book.id === lastBookId)?.id ?? accessible[0]?.id ?? null;
}

export function entryPath(options: {
  readonly pathname: string;
  readonly completed: boolean;
  readonly bookId: string | null;
}): string {
  // Explicit space visits and invitation deep links retain their intent.
  if (options.pathname === "/start" || options.pathname.startsWith("/start/") || options.pathname.startsWith("/join/")) {
    return options.pathname;
  }
  return !options.completed || options.bookId === null ? "/start" : "/";
}
