/**
 * Frame for screens that sit one level below the home page (settings, forms).
 * The back control lives at the top where a phone user's thumb expects it.
 */
export function InnerPage({
  title,
  subtitle,
  onBack,
  children,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly onBack: () => void;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-col gap-6 px-5 py-8">
      <button
        type="button"
        onClick={onBack}
        className="-mb-2 self-start text-sm text-muted transition hover:text-ink"
      >
        ← 返回
      </button>

      <header>
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle ? <p className="mt-1.5 text-sm leading-relaxed text-muted">{subtitle}</p> : null}
      </header>

      {children}
    </main>
  );
}
