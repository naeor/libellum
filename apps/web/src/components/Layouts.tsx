import { BottomNav } from "./BottomNav.js";

/**
 * Frame for the five tab destinations: content, then the fixed navigation.
 *
 * `pb-28` reserves room for the bar plus the raised entry button, so the last
 * row of a list is never trapped underneath it.
 */
export function TabPage({
  active,
  onNavigate,
  children,
  className = "",
}: {
  readonly active: string;
  readonly onNavigate: (to: string) => void;
  readonly children: React.ReactNode;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <div className="min-h-full pb-28">
      <div className={`mx-auto flex w-full max-w-md flex-col ${className}`}>{children}</div>
      <BottomNav active={active} onNavigate={onNavigate} />
    </div>
  );
}

/**
 * Frame for screens reached *from* a tab: back control at the top, no bottom
 * bar, because a form is a place you leave, not a place you switch away from.
 */
export function InnerPage({
  title,
  subtitle,
  onBack,
  actions,
  children,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly onBack: () => void;
  readonly actions?: React.ReactNode;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-col gap-6 px-5 py-8">
      <div className="flex items-start justify-between gap-4">
        <button
          type="button"
          onClick={onBack}
          className="-mb-2 self-start text-sm text-muted transition hover:text-ink"
        >
          ← 返回
        </button>
        {actions}
      </div>

      <header>
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle ? <p className="mt-1.5 text-sm leading-relaxed text-muted">{subtitle}</p> : null}
      </header>

      {children}
    </main>
  );
}
