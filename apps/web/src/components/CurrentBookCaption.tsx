/** Shared flex sibling above the tab bar; never overlays scrolling content. */
export function CurrentBookCaption({ name, hidden = false }: {
  readonly name: string | undefined;
  readonly hidden?: boolean;
}): React.JSX.Element | null {
  if (hidden || name === undefined) return null;
  return <p className="current-book-caption shrink-0 truncate px-6 py-2 text-micro text-muted" title={`当前账本：${name}`}>当前账本：{name}</p>;
}

