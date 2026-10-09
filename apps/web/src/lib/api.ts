import { apiErrorSchema } from "@libellum/shared";

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface RequestOptions {
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  readonly body?: unknown;
  /** Query parameters; `undefined` values are dropped. */
  readonly query?: Record<string, string | number | undefined>;
}

function buildUrl(path: string, query: RequestOptions["query"]): string {
  if (!query) return `/api/v1${path}`;

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }

  const suffix = search.toString();
  return suffix === "" ? `/api/v1${path}` : `/api/v1${path}?${suffix}`;
}

/**
 * How long a request may hang before it counts as a network failure.
 *
 * Without a deadline, a request on a dying connection can stay pending for
 * minutes: the save button sits on "保存中…" and the user learns nothing. A
 * clear failure after twenty seconds is far better than silence.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Thin wrapper around fetch.
 *
 * The session lives in an httpOnly cookie, so nothing here ever touches a
 * token — and `credentials: "same-origin"` is what makes the cookie travel.
 */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  // Fail immediately when the browser already knows there is no network.
  // Waiting for a timeout would leave the user staring at a spinner for
  // twenty seconds to learn something the browser knew at once.
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    throw new ApiRequestError(
      0,
      "offline",
      "当前处于离线状态，无法与服务器同步。请恢复网络后重试。",
    );
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  const init: RequestInit = {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal: controller.signal,
  };

  if (options.body !== undefined) {
    init.headers = { ...init.headers, "content-type": "application/json" };
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), init);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ApiRequestError(0, "timeout", "请求超时，请检查网络后重试。");
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }

  const raw = await response.text();
  // 204 has no body at all, and an empty body is not valid JSON.
  const payload: unknown = raw === "" ? undefined : JSON.parse(raw);

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);

    if (parsed.success) {
      throw new ApiRequestError(response.status, parsed.data.code, parsed.data.message, parsed.data.details);
    }

    throw new ApiRequestError(response.status, "unexpected_error", "服务暂时不可用，请稍后再试。");
  }

  return payload as T;
}

/** Turn any thrown value into something safe to show a user. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return "网络连接异常，请检查网络后重试。";
}
