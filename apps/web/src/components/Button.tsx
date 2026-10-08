import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand text-white shadow-sm hover:bg-brand-dark",
  secondary: "bg-brand-soft text-brand-dark hover:bg-brand-soft/70",
  ghost: "bg-transparent text-muted hover:text-ink",
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { readonly variant?: Variant }): React.JSX.Element {
  return (
    <button
      {...props}
      className={`inline-flex w-full items-center justify-center gap-2 rounded-field px-4 py-3 text-[15px] font-medium transition disabled:cursor-not-allowed disabled:opacity-45 ${VARIANTS[variant]} ${className}`}
    />
  );
}
