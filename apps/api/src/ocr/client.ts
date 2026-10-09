import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import type { OcrChannel, OcrDraft, OcrItemResult } from "@libellum/shared";

/**
 * Talks to the Python recogniser.
 *
 * The recogniser runs as one long-lived process, because loading its models
 * takes about two seconds and paying that per screenshot would triple the time
 * the user waits. Communication is one JSON object per line over stdin/stdout:
 * no port, therefore no port to secure, and no address for anything else on
 * the machine to reach.
 *
 * Images are passed as base64 in the message and never as a path. A payment
 * screenshot should not exist on disk even briefly — no temporary file to
 * clean up, no backup that quietly keeps a copy.
 *
 * The process is started on first use rather than at boot, so a deployment
 * that never uses recognition never pays the 260 MB of memory for it.
 */

/** Where the Python service lives, relative to the repository root. */
function serviceDirectory(): string {
  // The API runs from apps/api (dev) or from a built copy of it; either way the
  // OCR directory sits beside it inside the repository.
  const candidates = [
    path.resolve(process.cwd(), "apps/ocr"),
    path.resolve(process.cwd(), "../ocr"),
    path.resolve(process.cwd(), "../../apps/ocr"),
  ];

  return candidates.find((candidate) => existsSync(path.join(candidate, "service.py"))) ?? candidates[0]!;
}

function interpreterPath(directory: string): string {
  const override = process.env["LIBELLUM_OCR_PYTHON"];
  if (override !== undefined && override !== "") return override;

  return process.platform === "win32"
    ? path.join(directory, ".venv", "Scripts", "python.exe")
    : path.join(directory, ".venv", "bin", "python");
}

/** Raw shape the Python side sends. Translated to the shared type below. */
interface RawResponse {
  readonly id?: string;
  readonly ready?: boolean;
  readonly ok?: boolean;
  readonly error?: string;
  readonly message?: string;
  readonly lineCount?: number;
  readonly averageConfidence?: number;
  readonly seconds?: number;
  readonly draft?: {
    readonly amount?: string | null;
    readonly currency?: string;
    readonly occurred_local_date?: string | null;
    readonly occurred_time?: string | null;
    readonly kind?: string;
    readonly channel?: string | null;
    readonly counterparty?: string | null;
    readonly note?: string | null;
    readonly serial?: string | null;
    readonly is_refund?: boolean;
    readonly warnings?: string[];
  };
}

interface Pending {
  readonly resolve: (value: RawResponse) => void;
  readonly reject: (error: Error) => void;
}

/** How long to wait for one screenshot before giving up on it. */
const RECOGNIZE_TIMEOUT_MS = 20_000;
/** How long to wait for the models to load on first use. */
const STARTUP_TIMEOUT_MS = 60_000;

export class OcrService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, Pending>();
  private buffer = "";
  private nextId = 1;
  private readyPromise: Promise<void> | null = null;

  /** Start the recogniser if it is not already running. */
  private async ensureStarted(): Promise<void> {
    if (this.child !== null) return;
    if (this.readyPromise !== null) return this.readyPromise;

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const directory = serviceDirectory();
      const python = interpreterPath(directory);

      if (!existsSync(python)) {
        this.readyPromise = null;
        reject(
          new Error(
            `找不到 OCR 的 Python 环境（${python}）。请先运行 apps/ocr 里的安装步骤。`,
          ),
        );
        return;
      }

      const child = spawn(python, ["service.py"], {
        cwd: directory,
        stdio: ["pipe", "pipe", "pipe"],
        // Keep the output as text: the protocol is JSON lines, and decoding
        // buffers by hand would only add a way to get it wrong.
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      });

      this.child = child;

      const startupTimer = setTimeout(() => {
        reject(new Error("OCR 服务启动超时。"));
      }, STARTUP_TIMEOUT_MS);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        this.consume(chunk);
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        // Not fatal, but worth seeing: model loading warnings land here.
        console.warn("[ocr]", chunk.trim());
      });

      child.on("exit", (code) => {
        this.child = null;
        this.readyPromise = null;
        clearTimeout(startupTimer);

        for (const [, pending] of this.pending) {
          pending.reject(new Error(`OCR 服务已退出（code ${String(code)}）。`));
        }
        this.pending.clear();
      });

      child.on("error", (error) => {
        this.child = null;
        this.readyPromise = null;
        clearTimeout(startupTimer);
        reject(error);
      });

      this.onReady = () => {
        clearTimeout(startupTimer);
        resolve();
      };
    });

    return this.readyPromise;
  }

  private onReady: (() => void) | null = null;

  /** Split incoming text into lines; each complete line is one response. */
  private consume(chunk: string): void {
    this.buffer += chunk;

    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);

      if (line !== "") this.handleLine(line);

      newline = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let parsed: RawResponse;

    try {
      parsed = JSON.parse(line) as RawResponse;
    } catch {
      console.warn("[ocr] 无法解析的一行输出:", line.slice(0, 200));
      return;
    }

    if (parsed.ready === true) {
      this.onReady?.();
      return;
    }

    const id = parsed.id;
    if (id === undefined) return;

    const pending = this.pending.get(id);
    if (pending === undefined) return;

    this.pending.delete(id);
    pending.resolve(parsed);
  }

  /**
   * Recognise one image.
   *
   * Never throws for a bad image: an unreadable screenshot comes back as a
   * failed item so a batch can carry on with the rest. It throws only when the
   * service itself cannot run.
   */
  async recognize(image: Buffer, index: number): Promise<OcrItemResult> {
    await this.ensureStarted();

    const id = String(this.nextId++);
    const child = this.child;
    if (child === null) throw new Error("OCR 服务未运行。");

    const response = await new Promise<RawResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("OCR 识别超时。"));
      }, RECOGNIZE_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      child.stdin.write(`${JSON.stringify({ id, image: image.toString("base64") })}\n`);
    });

    return toItemResult(response, index);
  }

  /** Stop the recogniser. Used on shutdown so the process does not linger. */
  stop(): void {
    this.child?.kill();
    this.child = null;
    this.readyPromise = null;
  }
}

/** The Python side uses snake_case; the rest of the codebase does not. */
function toItemResult(response: RawResponse, index: number): OcrItemResult {
  const base = {
    index,
    lineCount: response.lineCount ?? 0,
    averageConfidence: response.averageConfidence ?? 0,
    seconds: response.seconds ?? 0,
  };

  if (response.ok !== true || response.draft === undefined) {
    return {
      ...base,
      ok: false,
      draft: null,
      error: response.error ?? "recognition_failed",
      message: response.message ?? "识别失败。",
    };
  }

  const raw = response.draft;
  const channel = raw.channel;

  const draft: OcrDraft = {
    amount: raw.amount ?? null,
    currency: raw.currency ?? "CNY",
    occurredLocalDate: raw.occurred_local_date ?? null,
    occurredTime: raw.occurred_time ?? null,
    kind: raw.kind === "income" ? "income" : "expense",
    channel: channel === "WECHAT" || channel === "ALIPAY" || channel === "BANK" ? (channel as OcrChannel) : null,
    counterparty: raw.counterparty ?? null,
    note: raw.note ?? null,
    serial: raw.serial ?? null,
    isRefund: raw.is_refund ?? false,
    warnings: raw.warnings ?? [],
  };

  return { ...base, ok: true, draft, error: null, message: null };
}
