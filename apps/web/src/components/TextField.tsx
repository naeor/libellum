import { useId, type InputHTMLAttributes } from "react";

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  readonly label: string;
  readonly hint?: string;
}

export function TextField({
  label,
  hint,
  className = "",
  ...props
}: TextFieldProps): React.JSX.Element {
  const id = useId();

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      <input
        id={id}
        {...props}
        className={`w-full rounded-field border border-line bg-surface px-3.5 py-3 text-base text-ink transition outline-none placeholder:text-muted/60 focus:border-brand focus:ring-4 focus:ring-brand-soft ${className}`}
      />
      {hint ? <p className="text-xs leading-relaxed text-muted">{hint}</p> : null}
    </div>
  );
}
