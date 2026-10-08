import { Card } from "./Card.js";

/**
 * Shared frame for the sign-in / sign-up / recovery screens: the wordmark, one
 * focused card, and a quiet footer link.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly children: React.ReactNode;
  readonly footer?: React.ReactNode;
}): React.JSX.Element {
  return (
    <main className="flex min-h-full items-center justify-center px-5 py-10">
      <div className="w-full max-w-sm">
        <header className="mb-8 text-center">
          <p className="text-2xl font-semibold tracking-tight text-ink">Libellum</p>
          <p className="mt-1 text-sm text-muted">the free, open ledger</p>
        </header>

        <Card>
          <h1 className="text-lg font-semibold text-ink">{title}</h1>
          {subtitle ? <p className="mt-1.5 text-sm leading-relaxed text-muted">{subtitle}</p> : null}
          <div className="mt-6 flex flex-col gap-5">{children}</div>
        </Card>

        {footer ? <div className="mt-6 text-center text-sm text-muted">{footer}</div> : null}
      </div>
    </main>
  );
}
