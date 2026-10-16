import { apiErrorSchema } from "@libellum/shared";

/**
 * The device id, for the request header.
 *
 * ⚠️ **Read synchronously from a value `device.ts` keeps in memory**, because a request header cannot await.
 * `primeDeviceId()` fills it before the first request goes out; **until then the header is omitted rather than
 * guessed**, and the server records the change as coming from an unidentified device — **which is honest, and
 * better than every device sharing one made-up name.**
 */
let deviceIdHeader = "";

export function primeDeviceId(id: string): void {
  deviceIdHeader = id;
}

function deviceHeader(): string {
  return deviceIdHeader;
}

/**
 * Which ledger the requests are about.
 *
 * ⚠️ **Every request that touches ledger data says which ledger, explicitly** — the owner's
 * decision, and his reason is the important part: *"离线写入发生的那一刻，就应该永久确定它
 * 属于哪本账，而不是等以后联网时才根据某个可变化的状态决定。"*
 *
 * That is why this is a header sent by one shared wrapper rather than a "current ledger" the
 * server remembers: a ledger the server remembers can change between the moment a person
 * records something offline and the moment it is delivered. **A header written at send time
 * from the value that was stored at write time cannot.**
 *
 * ⚠️ **Read synchronously from memory**, exactly like the device id above, because a request
 * header cannot await. `primeBookId()` fills it once the ledger is known; until then the
 * header is omitted and the server refuses the request with a clear message — which is
 * better than guessing a ledger.
 */
let bookIdHeader = "";

export function primeBookId(id: string | null): void {
  bookIdHeader = id ?? "";
}

/** The ledger id currently being addressed, or `""` when none is known yet. */
export function currentBookIdHeader(): string {
  return bookIdHeader;
}
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

/**
 * The headers every request carries.
 *
 * ⚠️ **One place builds them, so no screen ever has to remember to.** That is the owner's
 * instruction: *"旧接口可以通过统一客户端封装迁移，不需要让每个 UI 组件分别处理请求头."*
 *
 * `bookId` overrides the current ledger for a single call. The offline queue needs that:
 * **each queued change carries the ledger it was made in**, and those do not have to match
 * whichever ledger the person happens to be looking at when the network comes back.
 */
function buildHeaders(bookId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-libellum-device": deviceHeader(),
  };

  const book = bookId ?? bookIdHeader;
  if (book !== "") headers["x-libellum-book"] = book;

  return headers;
}

interface RequestOptions {
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  readonly body?: unknown;
  /** Query parameters; `undefined` values are dropped. */
  readonly query?: Record<string, string | number | undefined>;
  /**
   * A multipart body, sent as-is.
   *
   * The `Content-Type` header is deliberately left unset for these: only the
   * browser knows the boundary it generated, and setting the header by hand
   * produces a request the server cannot parse.
   */
  readonly formData?: FormData;
  /** Longer deadline for uploads, which are slower than a JSON call. */
  readonly timeoutMs?: number;
  /**
   * Address this ledger instead of the current one.
   *
   * ⚠️ Used by the offline queue, **not** by screens: a queued change belongs to the ledger
   * it was written in, and delivering it must not depend on what is on screen now.
   */
  readonly bookId?: string;
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
      "当前离线，请联网后重试此操作。",
    );
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => {
    controller.abort();
  }, options.timeoutMs ?? REQUEST_TIMEOUT_MS);

  const init: RequestInit = {
    method: options.method ?? "GET",
    credentials: "same-origin",
    /**
     * ⚠️ **Every request says which device it came from.**
     *
     * The conflict record has to answer "which two devices disagreed, and what did each send" — the owner asked
     * for that by name — **and the server cannot tell one device from another without being told.** Sending it on
     * every request keeps that fact in one place rather than being passed down through every call site.
     */
    headers: buildHeaders(options.bookId),
    signal: controller.signal,
  };

  if (options.formData !== undefined) {
    // No content-type: the browser adds one with the boundary it chose.
    init.body = options.formData;
  } else if (options.body !== undefined) {
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
  let payload: unknown;
  try {
    payload = raw === "" ? undefined : JSON.parse(raw);
  } catch {
    // A body that is not JSON means something answered that is not this API —
    // a proxy error page, a captive portal, a truncated response. Saying so is
    // the difference between a five-minute diagnosis and an afternoon of it.
    throw new ApiRequestError(
      response.status,
      "malformed_response",
      `服务器返回了无法解析的内容（HTTP ${String(response.status)}），可能不是本应用的服务。`,
    );
  }

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);

    if (parsed.success) {
      throw new ApiRequestError(response.status, parsed.data.code, parsed.data.message, parsed.data.details);
    }

    throw new ApiRequestError(response.status, "unexpected_error", "服务暂时不可用，请稍后再试。");
  }

  return payload as T;
}

/**
 * Fetch a file from the server, bytes and metadata together.
 *
 * The file arrives as the response *body*, not as base64 inside JSON. That is a
 * correction: an earlier version wrapped the bytes in JSON, which is 33% larger
 * and, far worse, would have hit Fastify's one-megabyte body limit at roughly a
 * thousand entries — an export that works until the ledger gets big enough to
 * matter. Here the bytes stream and the metadata rides in response headers.
 *
 * Those headers have to be named in `access-control-expose-headers` for the
 * browser to let this code read them; the server does that. A cross-origin
 * `fetch` is otherwise allowed to see only a handful of standard headers, and
 * going through the Vite proxy counts as cross-origin.
 *
 * Error handling matches `apiFetch`: a failed export answers with the same JSON
 * error body, so it is parsed and thrown rather than handed back as a file.
 */
export interface FetchedFile {
  readonly bytes: Uint8Array;
  readonly fileRef: string;
  readonly rowCount: number;
}

export async function apiFetchFile(
  path: string,
  query?: Record<string, string | undefined>,
  timeoutMs = 120_000,
  bookId?: string,
): Promise<FetchedFile> {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    throw new ApiRequestError(0, "offline", "当前离线，请联网后重试此操作。");
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method: "GET",
      credentials: "same-origin",
      /**
       * ⚠️ The same headers as the JSON calls, minus the JSON `accept`.
       *
       * A download is a request about a ledger too — the export route reads the ledger named
       * in the header — so it goes through the same builder rather than hand-rolling its own.
       */
      headers: { ...buildHeaders(bookId), accept: "*/*" },
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ApiRequestError(0, "timeout", "请求超时，请检查网络后重试。");
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }

  if (!response.ok) {
    const raw = await response.text();
    let payload: unknown;
    try {
      payload = raw === "" ? undefined : JSON.parse(raw);
    } catch {
      throw new ApiRequestError(
        response.status,
        "malformed_response",
        `服务器返回了无法解析的内容（HTTP ${String(response.status)}）。`,
      );
    }

    const parsed = apiErrorSchema.safeParse(payload);
    if (parsed.success) {
      throw new ApiRequestError(response.status, parsed.data.code, parsed.data.message, parsed.data.details);
    }
    throw new ApiRequestError(response.status, "unexpected_error", "服务暂时不可用，请稍后再试。");
  }

  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    fileRef: response.headers.get("x-libellum-file-ref") ?? "",
    rowCount: Number(response.headers.get("x-libellum-row-count") ?? "0"),
  };
}

/**
 * Turn any thrown value into something safe to show a user.
 *
 * `ApiRequestError` already carries a message the server wrote for a person to
 * read, so it passes through. Anything else is a failure the wrapper could not
 * classify — and the old text for that was a flat "网络连接异常，请检查网络后重试",
 * which blamed the network whatever had actually happened.
 *
 * That was not a hypothetical cost. When the owner photographed a bill and was
 * told his network was at fault, the network was fine: the message simply had
 * nothing to do with the cause, and it took a round of server-side measurement
 * to find that out. The replacement states what is known, tells the user it is
 * not their fault, and points at the one thing they can try.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;

  // A thrown `Error` at least has a name and a message; a thrown string or
  // object does not, and `String()` on those gives something useless.
  const detail = error instanceof Error ? error.message : String(error);

  return (
    "操作没有完成：请求未能送达服务器或响应无法识别。这不是你的操作问题。" +
    `请重试一次；若仍然失败，请把这行信息告诉开发者（${detail.slice(0, 120)}）。`
  );
}
