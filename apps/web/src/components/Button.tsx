import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand text-white shadow-sm hover:bg-brand-dark",
  secondary: "bg-brand-soft text-brand-dark hover:bg-brand-soft/70",
  ghost: "bg-transparent text-muted hover:text-ink",
};

export function Button({
  variant = "primary",
  fullWidth = true,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: Variant;
  /**
   * Buttons stretch to fill their container by default. Width is a prop rather
   * than a class override because Tailwind resolves `w-full` vs `w-auto` by
   * stylesheet order, not by the order they appear in `className`.
   */
  readonly fullWidth?: boolean;
}): React.JSX.Element {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-field px-4 py-3 text-[15px] font-medium transition disabled:cursor-not-allowed disabled:opacity-45 ${
        fullWidth ? "w-full" : "w-auto"
      } ${VARIANTS[variant]} ${className}`}
    />
  );
}
