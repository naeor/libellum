type Tone = "error" | "info" | "success";

const TONES: Record<Tone, string> = {
  error: "bg-danger-soft text-danger",
  info: "bg-brand-soft text-brand-dark",
  success: "bg-brand-soft text-brand-dark",
};

export function Alert({
  tone = "error",
  children,
}: {
  readonly tone?: Tone;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div role="status" className={`rounded-field px-4 py-3 text-sm leading-relaxed ${TONES[tone]}`}>
      {children}
    </div>
  );
}
