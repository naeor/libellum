import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Talks to the Python transcriber.
 *
 * The same shape as the OCR client beside it, and for the same reasons: one
 * long-lived process because loading the model costs six seconds, JSON lines over
 * a pipe rather than HTTP because a pipe has no address to secure.
 *
 * **The audio never touches the disk.** It arrives as a buffer from the request,
 * is base64-encoded into the message, and is decoded in the child's memory. This
 * matters more here than it does for a screenshot: a recording of somebody's
 * voice is the most sensitive thing this project handles, and a temporary file is
 * a thing that can be forgotten, backed up, or read by something else on the
 * machine.
 *
 * **`transcribe` is the entire interface.** The engine behind it — whisper.cpp
 * today, `faster-whisper` or a hosted API later, or the browser's own engine
 * instead of a server call at all — is this file's business and nobody else's.
 * The owner asked for that seam, because the hard part is the recognition and the
 * easy-to-get-wrong part is turning a sentence into fields.
 */

/** Where the Python service lives, relative to the repository root. */
function serviceDirectory(): string {
  const candidates = [
    path.resolve(process.cwd(), "apps/voice"),
    path.resolve(process.cwd(), "../voice"),
    path.resolve(process.cwd(), "../../apps/voice"),
  ];

  return candidates.find((candidate) => existsSync(path.join(candidate, "service.py"))) ?? candidates[0]!;
}

/**
 * Which Python runs it.
 *
 * **The OCR virtualenv, reused.** Speech and OCR are two sidecars of one project,
 * and building a second environment would mean a second copy of numpy and a
 * second place to forget to install something. `LIBELLUM_VOICE_PYTHON` overrides
 * it, which is what a deployment with a separate environment would set.
 */
function interpreterPath(directory: string): string {
  const override = process.env["LIBELLUM_VOICE_PYTHON"];
  if (override !== undefined && override !== "") return override;

  const ocrDirectory = path.resolve(directory, "..", "ocr");
  const shared = process.platform === "win32"
    ? path.join(ocrDirectory, ".venv", "Scripts", "python.exe")
    : path.join(ocrDirectory, ".venv", "bin", "python");

  if (existsSync(shared)) return shared;

  return process.platform === "win32"
    ? path.join(directory, ".venv", "Scripts", "python.exe")
    : path.join(directory, ".venv", "bin", "python");
}

/** Raw shape the Python side sends. */
interface RawResponse {
  readonly id?: string;
  readonly ready?: boolean;
  readonly loading?: boolean;
  readonly ok?: boolean;
  readonly error?: string;
  readonly message?: string;
  readonly text?: string;
  readonly seconds?: number;
  readonly audioSeconds?: number;
}

export interface Transcription {
  readonly text: string;
  readonly audioSeconds: number;
  readonly seconds: number;
}

/** Raised when the audio itself is the problem, with a message worth showing. */
export class TranscriptionRejected extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "TranscriptionRejected";
  }
}

interface Pending {
  readonly resolve: (value: RawResponse) => void;
  readonly reject: (error: Error) => void;
}

/**
 * How long to wait for one recording.
 *
 * Generous: the model is loaded once, but the first request after a long idle
 * period pays the operating system's page-in cost on top of the transcription,
 * and a thirty-second clip on a small server is not instant.
 */
const TRANSCRIBE_TIMEOUT_MS = 120_000;
/** How long to wait for the model to load on first use. */
const STARTUP_TIMEOUT_MS = 180_000;

export class VoiceService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, Pending>();
  private buffer = "";
  private nextId = 1;
  private readyPromise: Promise<void> | null = null;
  private onReady: (() => void) | null = null;

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
            `找不到语音识别的 Python 环境（${python}）。请先运行 apps/ocr 里的安装步骤，并安装 pywhispercpp 与 av。`,
          ),
        );
        return;
      }

      const child = spawn(python, ["service.py"], {
        cwd: directory,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      });

      this.child = child;

      const startupTimer = setTimeout(() => {
        reject(new Error("语音识别服务启动超时。"));
      }, STARTUP_TIMEOUT_MS);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        this.consume(chunk);
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        // Not fatal. Model loading writes its progress here, which is worth
        // seeing the first time and noise afterwards.
        const line = chunk.trim();
        if (line !== "") console.warn("[voice]", line);
      });

      child.on("exit", (code) => {
        this.child = null;
        this.readyPromise = null;
        clearTimeout(startupTimer);

        for (const [, pending] of this.pending) {
          pending.reject(new Error(`语音识别服务已退出（code ${String(code)}）。`));
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
      console.warn("[voice] 无法解析的一行输出:", line.slice(0, 200));
      return;
    }

    // `{"ready": false, "loading": true}` is the service saying it has started.
    // Treated as ready so the caller stops waiting: the *first transcription*
    // carries its own, longer timeout, and blocking the request here for six
    // seconds of model loading would hide the progress from the user.
    if (parsed.ready !== undefined || parsed.loading === true) {
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
   * Transcribe one recording.
   *
   * Throws `TranscriptionRejected` when the audio is unusable — too long, the
   * wrong format, silent — because that is something the user can act on. Throws
   * a plain `Error` only when the service itself cannot run, which is not.
   */
  async transcribe(audio: Buffer, language = "zh"): Promise<Transcription> {
    await this.ensureStarted();

    const id = String(this.nextId++);
    const child = this.child;
    if (child === null) throw new Error("语音识别服务未运行。");

    const response = await new Promise<RawResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("语音识别超时。"));
      }, TRANSCRIBE_TIMEOUT_MS);

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

      child.stdin.write(`${JSON.stringify({ id, audio: audio.toString("base64"), language })}\n`);
    });

    if (response.ok !== true) {
      throw new TranscriptionRejected(
        response.error ?? "transcribe_failed",
        response.message ?? "识别失败，请再试一次。",
      );
    }

    return {
      text: response.text ?? "",
      audioSeconds: response.audioSeconds ?? 0,
      seconds: response.seconds ?? 0,
    };
  }

  /** Stop the transcriber so the process does not outlive the server. */
  stop(): void {
    this.child?.kill();
    this.child = null;
    this.readyPromise = null;
  }
}
