import { useCallback, useEffect, useRef, useState } from "react";

import { MAX_SPEECH_SECONDS } from "@libellum/shared";

import { LINE_COUNT, bandLevels, lineAmplitudes, secondsLeft } from "./voiceBars.js";

/**
 * Recording from the microphone, and the levels that drive the moving lines.
 *
 * ⚠️ **No native picker, unlike the camera.** `getUserMedia` + `MediaRecorder`
 * are ordinary web APIs with no browser-drawn interface, so the whole look of
 * this is ours to decide — which is why the owner could ask for lines that move
 * instead of the recording widget Safari would never have given him anyway.
 *
 * Three things this file exists to get right:
 *
 *  * **The container is the browser's choice, not ours.** Chrome produces
 *    `audio/webm;codecs=opus`, Safari produces `audio/mp4` with AAC. Both are
 *    recognised by the server; the list below is ordered by preference and the
 *    first one the browser admits to supporting wins.
 *  * **The recording stops itself at the limit.** Thirty seconds is the owner's
 *    number, and enforcing it afterwards would waste the thirty seconds it took
 *    to earn the refusal.
 *  * **The microphone is released on every exit.** A live `MediaStream` keeps the
 *    browser's recording indicator on and the microphone hot; leaving one running
 *    because a component unmounted is the kind of bug a user notices and never
 *    forgives.
 */

/** Most preferred first. The browser picks the first it can actually record. */
const CANDIDATE_TYPES = [
  "audio/mp4",
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
];

export type RecorderState = "idle" | "starting" | "recording" | "stopping";

/**
 * Why the microphone cannot be used, when it cannot.
 *
 * ⚠️ **The distinction that this exists for.** `getUserMedia` and `MediaRecorder`
 * are secure-context APIs, so over `http://192.168.0.184:5173` — how a phone on
 * the home Wi-Fi reaches the dev machine — `navigator.mediaDevices` is
 * `undefined`. The first version of this reported that as "这个浏览器不支持录音",
 * which is wrong twice over: the browser supports it perfectly, **and no
 * permission prompt appears because there is no API to prompt for.**
 *
 * The owner read that message and went looking at his browser. The cause was the
 * URL. Naming it costs one string and saves that trip.
 */
export type RecorderBlocker = "insecure-context" | "unsupported" | null;

/**
 * The browser facts this file needs, as a parameter.
 *
 * Taken as an argument with a default of "read the globals" so the decision can
 * be tested **without a DOM** — the web package's test environment is `node`,
 * which has no `window`, and adding jsdom for two boolean checks would cost more
 * than the seam does. It is also honest about what the function depends on.
 */
export interface MediaContext {
  readonly isSecureContext: boolean;
  readonly protocol: string;
  readonly hasGetUserMedia: boolean;
  readonly hasMediaRecorder: boolean;
}

function readMediaContext(): MediaContext {
  if (typeof window === "undefined") {
    return { isSecureContext: false, protocol: "", hasGetUserMedia: false, hasMediaRecorder: false };
  }

  return {
    isSecureContext: window.isSecureContext,
    protocol: window.location.protocol,
    hasGetUserMedia: typeof navigator.mediaDevices?.getUserMedia === "function",
    hasMediaRecorder: typeof MediaRecorder !== "undefined",
  };
}

/** Whether the page is in a context where the browser defines media APIs. */
export function isSecureContextForMedia(context: MediaContext = readMediaContext()): boolean {
  // `isSecureContext` is the browser's own answer and already handles
  // `localhost`, so it is trusted over a hand-written check of protocol and
  // hostname. The protocol is the fallback for a browser without the flag.
  return context.isSecureContext || context.protocol === "https:";
}

/**
 * Which of the two reasons applies, or `null` when recording is available.
 *
 * Checked in this order because the insecure context is the one that *looks* like
 * the other: a secure-context API that does not exist is indistinguishable from
 * a browser that does not have it, unless the context is asked about first.
 */
export function detectBlocker(context: MediaContext = readMediaContext()): RecorderBlocker {
  if (!isSecureContextForMedia(context)) return "insecure-context";
  if (!context.hasGetUserMedia || !context.hasMediaRecorder) return "unsupported";

  return null;
}

/** How to say the problem, and what the user can do about it. */
export function describeBlocker(blocker: RecorderBlocker): string | null {
  if (blocker === "insecure-context") {
    return (
      "这个地址不是安全连接，浏览器不提供录音能力。请改用 https 地址打开" +
      "（手机访问时用启动窗口里打印的 https 地址），或者改用手动记账。"
    );
  }

  if (blocker === "unsupported") {
    return "这个浏览器不支持录音。可以改用手动记账，功能不受影响。";
  }

  return null;
}

export interface VoiceRecorder {
  readonly state: RecorderState;
  /** Draw amplitudes, one per line, refreshed every frame while recording. */
  readonly amplitudes: readonly number[];
  readonly secondsLeft: number;
  /** Seconds recorded so far, counting up. */
  readonly elapsed: number;
  /** A message worth showing, e.g. the microphone was refused. */
  readonly error: string | null;
  /** Whether this page can record at all. */
  readonly supported: boolean;
  /** Why not, when it cannot. */
  readonly blocker: RecorderBlocker;
  readonly start: () => Promise<void>;
  readonly stop: () => void;
}

/** What the browser actually recorded, once it has stopped. */
export interface Recording {
  readonly blob: Blob;
  readonly mimeType: string;
  readonly seconds: number;
}

/**
 * Pick a container the browser admits to supporting.
 *
 * `isTypeSupported` is checked rather than assumed, because a `MediaRecorder`
 * constructed with a type it cannot record throws — and the throw happens after
 * the user has already granted microphone permission, which is a bad moment to
 * discover a configuration mistake.
 */
export function pickMimeType(isSupported: (type: string) => boolean): string | null {
  return CANDIDATE_TYPES.find((type) => isSupported(type)) ?? null;
}

export function useVoiceRecorder(
  onRecorded: (recording: Recording) => void,
  limitSeconds: number = MAX_SPEECH_SECONDS,
): VoiceRecorder {
  const [state, setState] = useState<RecorderState>("idle");
  const [amplitudes, setAmplitudes] = useState<readonly number[]>(
    () => Array.from({ length: LINE_COUNT }, () => 0),
  );
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const frameRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const stoppingRef = useRef<"user" | "limit" | null>(null);

  // `onRecorded` is called from an event handler created once per recording, so it
  // has to be read through a ref — capturing it would call the first render's
  // version, which closes over stale state.
  const onRecordedRef = useRef(onRecorded);
  onRecordedRef.current = onRecorded;

  const supported = detectBlocker() === null;
  const blocker = detectBlocker();

  /** Stop everything and let the microphone go. Safe to call twice. */
  const release = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }

    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;

    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    analyserRef.current = null;
  }, []);

  useEffect(() => release, [release]);

  /** Draw the lines, and stop the recording when the limit is reached. */
  const pump = useCallback(() => {
    const analyser = analyserRef.current;
    const recorder = recorderRef.current;

    if (analyser === null || recorder === null) return;

    const spectrum = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(spectrum);

    setAmplitudes(lineAmplitudes(bandLevels(spectrum)));

    const millis = Date.now() - startedAtRef.current;
    setElapsed(millis / 1000);

    /**
     * The limit is enforced here, mid-frame, rather than by a `setTimeout`.
     *
     * A timer and a draw loop drift apart, and the failure would be a recording
     * a few hundred milliseconds over the server's own limit — which the server
     * refuses, after the user has waited. One clock, one place.
     */
    if (millis >= limitSeconds * 1000 && recorder.state === "recording") {
      stoppingRef.current = "limit";
      recorder.stop();
    }

    frameRef.current = requestAnimationFrame(pump);
  }, [limitSeconds]);

  const start = useCallback(async () => {
    if (state !== "idle" && state !== "stopping") return;

    setError(null);
    setState("starting");

    try {
      /**
       * The permission prompt happens in here, on the user's tap.
       *
       * Safari requires `getUserMedia` to be called from a user gesture, and a
       * screen that asks for the microphone on mount would simply be refused on
       * iOS with no prompt at all — which looks like a broken app rather than a
       * refused permission.
       */
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Off, because whisper is transcribing a sentence about a purchase and
          // these are the settings that make a phone microphone sound like a
          // conference call.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      streamRef.current = stream;

      const mimeType = pickMimeType((type) => MediaRecorder.isTypeSupported(type));

      const recorder = new MediaRecorder(stream, mimeType === null ? undefined : { mimeType });
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        const seconds = (Date.now() - startedAtRef.current) / 1000;
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        const byLimit = stoppingRef.current === "limit";
        stoppingRef.current = null;

        release();
        setState("idle");
        setElapsed(0);
        setAmplitudes(Array.from({ length: LINE_COUNT }, () => 0));

        if (blob.size === 0) {
          setError(byLimit ? "没有录到声音。" : "录音是空的，请再试一次。");
          return;
        }

        onRecordedRef.current({ blob, mimeType: recorder.mimeType, seconds });
      };

      // The levels, from the same stream the recorder is using.
      const context = new AudioContext();
      audioContextRef.current = context;
      const analyser = context.createAnalyser();
      // Small, because the lines are a level display rather than a spectrum
      // analyser: a fine-grained transform would only add latency to the movement.
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      context.createMediaStreamSource(stream).connect(analyser);
      analyserRef.current = analyser;

      startedAtRef.current = Date.now();
      stoppingRef.current = null;
      recorder.start();
      setState("recording");
      frameRef.current = requestAnimationFrame(pump);
    } catch (caught) {
      release();
      setState("idle");
      setError(describeMicrophoneError(caught));
    }
  }, [state, release, pump]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder === null || recorder.state !== "recording") return;

    setState("stopping");
    stoppingRef.current = "user";
    recorder.stop();
  }, []);

  return {
    state,
    amplitudes,
    secondsLeft: secondsLeft(elapsed * 1000, limitSeconds),
    elapsed,
    error,
    supported,
    blocker,
    start,
    stop,
  };
}

/**
 * Turn a `getUserMedia` failure into something a person can act on.
 *
 * The distinctions matter: a refused permission is fixed in the browser's
 * settings, a missing microphone is fixed by plugging one in, and "something went
 * wrong" is fixed by nothing. The owner's rule about error copy applies — say what
 * happened, and do not blame the wrong thing.
 */
function describeMicrophoneError(caught: unknown): string {
  const name = caught instanceof DOMException ? caught.name : "";

  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "浏览器没有允许使用麦克风。可以在浏览器的网站设置里打开麦克风权限，或者改用手动记账。";
    case "NotFoundError":
    case "OverconstrainedError":
      return "没有找到可用的麦克风。可以改用手动记账。";
    case "NotReadableError":
      return "麦克风被其它程序占用了。关掉正在用麦克风的程序再试一次。";
    default:
      return "没能开始录音。可以改用手动记账。";
  }
}
