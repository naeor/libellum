/**
 * The circled "i" that explains what a preset category is for.
 *
 * Drawn with a border and a letter rather than an icon file: it is one glyph,
 * and it inherits the surrounding colour and size for free.
 */
export function InfoIcon({ className = "" }: { readonly className?: string }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex size-4 items-center justify-center rounded-full border border-current text-[10px] leading-none ${className}`}
    >
      i
    </span>
  );
}
