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
}

/**
 * Thin wrapper around fetch.
 *
 * The session lives in an httpOnly cookie, so nothing here ever touches a
 * token — and `credentials: "same-origin"` is what makes the cookie travel.
 */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const init: RequestInit = {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  };

  if (options.body !== undefined) {
    init.headers = { ...init.headers, "content-type": "application/json" };
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(`/api/v1${path}`, init);
  const raw = await response.text();
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
  return "网络连接异常，请稍后再试。";
}
