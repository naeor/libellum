import { healthResponseSchema, type HealthResponse } from "@libellum/shared";
import { useEffect, useState } from "react";

type HealthState =
  | { readonly status: "loading" }
  | { readonly status: "ok"; readonly health: HealthResponse }
  | { readonly status: "error"; readonly message: string };

/**
 * Stage S1 placeholder screen.
 *
 * It is deliberately more than a "hello world": it calls the real API through
 * the dev proxy and validates the response with the shared Zod schema, so one
 * glance at this page proves that web -> proxy -> Fastify -> shared types all
 * line up.
 */
export default function App(): React.JSX.Element {
  const [state, setState] = useState<HealthState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();

    async function load(): Promise<void> {
      try {
        const response = await fetch("/api/v1/health", { signal: controller.signal });

        if (!response.ok) {
          throw new Error(`API returned HTTP ${String(response.status)}`);
        }

        const health = healthResponseSchema.parse(await response.json());
        setState({ status: "ok", health });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    void load();

    return () => {
      controller.abort();
    };
  }, []);

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-12 text-slate-100">
      <div className="mx-auto flex max-w-md flex-col gap-8">
        <header className="flex flex-col gap-2">
          <h1 className="text-4xl font-semibold tracking-tight">Libellum</h1>
          <p className="text-slate-400">the free, open ledger</p>
        </header>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
          <h2 className="mb-3 text-sm font-medium tracking-wide text-slate-400 uppercase">
            System status
          </h2>

          {state.status === "loading" && <p className="text-slate-300">Checking the API…</p>}

          {state.status === "error" && (
            <div className="flex flex-col gap-1">
              <p className="font-medium text-red-400">API unreachable</p>
              <p className="text-sm break-words text-slate-400">{state.message}</p>
              <p className="mt-2 text-xs text-slate-500">
                Start it with <code className="text-slate-300">pnpm dev:api</code>.
              </p>
            </div>
          )}

          {state.status === "ok" && (
            <dl className="grid grid-cols-2 gap-y-3 text-sm">
              <dt className="text-slate-400">Service</dt>
              <dd className="text-right font-mono">{state.health.service}</dd>

              <dt className="text-slate-400">Version</dt>
              <dd className="text-right font-mono">{state.health.version}</dd>

              <dt className="text-slate-400">Database</dt>
              <dd
                className={
                  state.health.database === "up"
                    ? "text-right font-mono text-emerald-400"
                    : "text-right font-mono text-amber-400"
                }
              >
                {state.health.database}
              </dd>

              <dt className="text-slate-400">Checked at</dt>
              <dd className="text-right font-mono text-xs">
                {new Date(state.health.timestamp).toLocaleTimeString()}
              </dd>
            </dl>
          )}
        </section>

        <footer className="text-xs text-slate-500">
          Stage S1 — project skeleton. Real bookkeeping screens arrive in S2 and S3. Licensed
          AGPL-3.0.
        </footer>
      </div>
    </main>
  );
}
