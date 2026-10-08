/**
 * Reads and validates process configuration.
 *
 * Values come from the environment (in development, loaded from the repo-root
 * `.env` via Node's `--env-file-if-exists`). Secrets never have defaults: the
 * process must fail loudly rather than start in a half-configured state.
 */

function readString(name: string, fallback?: string): string {
  const raw = process.env[name];

  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return raw;
}

function readPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a valid port number, received: ${raw}`);
  }

  return port;
}

export interface Env {
  readonly nodeEnv: "development" | "production" | "test";
  readonly apiHost: string;
  readonly apiPort: number;
  readonly databaseUrl: string;
  readonly webOrigin: string;
}

export function loadEnv(): Env {
  const nodeEnv = readString("NODE_ENV", "development");
  if (nodeEnv !== "development" && nodeEnv !== "production" && nodeEnv !== "test") {
    throw new Error(`NODE_ENV must be development, production or test, received: ${nodeEnv}`);
  }

  return {
    nodeEnv,
    // Development binds to the loopback interface on purpose: listening on
    // 0.0.0.0 makes Windows Defender Firewall pop up an "allow this app"
    // dialog (which needs administrator approval) every time the dev server
    // starts, and it exposes an unauthenticated dev server to the LAN.
    // Containers in production must bind 0.0.0.0 to be reachable.
    apiHost: readString("API_HOST", nodeEnv === "production" ? "0.0.0.0" : "127.0.0.1"),
    apiPort: readPort("API_PORT", 3000),
    databaseUrl: readString("DATABASE_URL"),
    webOrigin: readString("WEB_ORIGIN", "http://localhost:5173"),
  };
}
