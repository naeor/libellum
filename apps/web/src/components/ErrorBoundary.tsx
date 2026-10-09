import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Last line of defence against a blank screen.
 *
 * Without this, an exception anywhere in the tree unmounts everything and the
 * user is left staring at an empty page with no explanation and no way out.
 * That is the worst possible failure for an application somebody trusts with
 * their money, so it gets a real screen: what happened, and a way to recover.
 *
 * The message is shown deliberately. This is a self-hosted tool used by people
 * who can act on a stack trace — hiding it behind "something went wrong" would
 * only make a report harder to act on.
 */
interface ErrorBoundaryState {
  readonly error: Error | null;
}

export class ErrorBoundary extends Component<{ readonly children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept in the console so a screenshot of devtools is enough to diagnose it.
    console.error("Unhandled render error:", error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;

    if (!error) return this.props.children;

    return (
      <main className="mx-auto flex min-h-full w-full max-w-md flex-col items-center justify-center gap-4 px-6 py-12 text-center">
        <p className="text-lg font-semibold text-ink">页面无法显示</p>
        <p className="text-sm leading-relaxed text-muted">
          界面遇到了一个未预期的问题。你的账目数据保存在服务器上，不受影响。
        </p>

        <pre className="w-full overflow-x-auto rounded-field bg-danger-soft p-3 text-left text-xs leading-relaxed whitespace-pre-wrap text-danger">
          {error.message}
        </pre>

        <button
          type="button"
          onClick={() => {
            window.location.reload();
          }}
          className="w-full rounded-field bg-brand py-3 text-sm font-medium text-white transition hover:bg-brand-dark"
        >
          刷新页面
        </button>

        <button
          type="button"
          onClick={() => {
            window.location.href = "/";
          }}
          className="w-full rounded-field bg-brand-soft py-3 text-sm font-medium text-brand-dark transition hover:bg-brand-soft/70"
        >
          回到明细
        </button>
      </main>
    );
  }
}
