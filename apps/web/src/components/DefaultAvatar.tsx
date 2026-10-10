/**
 * The placeholder avatar: a six-petal flower.
 *
 * Drawn rather than shipped as an image, so it stays crisp at any size and
 * adds nothing to the download.
 *
 * It is a separate component because it is temporary by design — accounts will
 * be able to set their own avatar (see H3 in the backlog), and when that lands
 * this file is the only thing that changes. Deliberately quiet: a default
 * avatar is something the owner did not choose, so it should not look like a
 * statement.
 *
 * The colours come from the theme's variables rather than from literals, so this
 * follows the accent colour like everything else. See `docs/COLORS.md`: the
 * petals are the accent, the disc behind them is the surface, and the centre dot
 * is the accent's soft tint.
 */
export function DefaultAvatar({ className = "size-24" }: { readonly className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 96 96" className={className} aria-hidden="true">
      <circle cx="48" cy="48" r="48" fill="var(--color-surface)" fillOpacity="0.92" />
      <g transform="translate(48 50)" fill="var(--color-brand)">
        {[0, 60, 120, 180, 240, 300].map((angle) => (
          <ellipse
            key={angle}
            cx="0"
            cy="-15"
            rx="8.5"
            ry="13"
            fillOpacity="0.9"
            transform={`rotate(${String(angle)})`}
          />
        ))}
        <circle r="7.5" fill="var(--color-brand-soft)" />
        <circle r="3.6" />
      </g>
    </svg>
  );
}
