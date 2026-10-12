import {
  MAX_SPEECH_BYTES,
  isSpeechless,
  parseSpokenEntryWithCategory,
  transcribeResponseSchema,
} from "@libellum/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { PrismaClient } from "../db.js";
import { badRequest, tooManyRequests } from "../lib/errors.js";
import { TranscriptionRejected, type VoiceService } from "../voice/client.js";

interface VoiceRouteOptions {
  readonly requireAuth: (request: FastifyRequest) => Promise<void>;
  /** Needed to read the ledger's categories, for the category guess. */
  readonly prisma: PrismaClient;
  /** Only this one method is needed, so a stub can stand in without the rest. */
  readonly voice: Pick<VoiceService, "transcribe">;
}

/**
 * `POST /api/v1/voice/transcribe` — hear a recording, return guesses.
 *
 * Nothing is saved, and the audio is gone by the time this answers. The endpoint
 * turns a recording into text plus the fields read out of the text, so the review
 * form can start filled in.
 *
 * **The fields are computed here rather than in the browser**, even though
 * `parseSpokenEntry` is shared code that would run in either place. It runs here
 * so that the *same* text produces the *same* fields whoever is asking — which
 * matters the moment there is a second client, and costs nothing today.
 */
export function registerVoiceRoutes(app: FastifyInstance, options: VoiceRouteOptions): void {
  const { requireAuth, prisma, voice } = options;

  app.post("/api/v1/voice/transcribe", { preHandler: requireAuth }, async (request) => {
    if (!request.isMultipart()) {
      throw badRequest("expected_multipart", "请以上传音频的方式提交。");
    }

    /**
     * Read the one part, with a ceiling.
     *
     * The limit is enforced twice on purpose: `toBuffer` refuses anything larger
     * than this while reading, so an oversized upload never has to fit in memory
     * to be rejected, and the length is checked again afterwards because
     * `truncated` says the client stopped mid-write.
     */
    let audio: Buffer | null = null;
    let declaredName = "";

    for await (const part of request.parts()) {
      if (part.type !== "file") continue;

      // The first file wins. A second one is a client bug rather than something
      // to merge, and quietly using the last would make it invisible.
      if (audio !== null) continue;

      declaredName = part.filename;
      audio = await part.toBuffer();
    }

    if (audio === null) {
      throw badRequest("audio_missing", "没有收到录音。");
    }

    if (audio.length === 0) {
      throw badRequest("audio_empty", "录音是空的，请再录一次。");
    }

    if (audio.length > MAX_SPEECH_BYTES) {
      throw badRequest("audio_too_large", "录音文件过大，请说得短一点。");
    }

    /**
     * Sniffed rather than trusted.
     *
     * A declared `Content-Type` is whatever the client felt like sending, and the
     * first bytes are not something a caller chooses independently of the data.
     * The browser's own container is `ftyp…` for Safari's mp4 and `1A 45 DF A3`
     * for Chrome's webm; anything else is not something a `MediaRecorder`
     * produced, and the transcriber would fail on it in a less useful way.
     */
    if (!looksLikeAudio(audio)) {
      request.log.warn({ declaredName, bytes: audio.length }, "voice: unrecognised audio container");
      throw badRequest("audio_unsupported", "这个音频格式无法识别，请重新录制。");
    }

    try {
      const result = await voice.transcribe(audio);

      /**
       * Silence is reported as a success with empty fields, not as an error.
       *
       * The distinction matters to the interface: "we heard nothing" belongs next
       * to the microphone — try again — while an error belongs in a banner. The
       * text is emptied so nothing downstream can offer `[BLANK_AUDIO]` as a note.
       */
      if (isSpeechless(result.text)) {
        return transcribeResponseSchema.parse({
          text: "",
          amount: null,
          kind: "expense",
          note: "",
          categoryId: null,
          categoryMatched: [],
          audioSeconds: result.audioSeconds,
          seconds: result.seconds,
        });
      }

      /**
       * The category guess needs the ledger, so it is read here.
       *
       * **Read from the database rather than sent by the client**, and that is the
       * point: a client could be out of date, or could name a category from a
       * different ledger, and the API would then reject the saved entry with a
       * message the user cannot act on. The server already knows which categories
       * this person has.
       *
       * ⚠️ **The ledger comes from the request, and the request already proved the caller is a
       * member of it** — see `requireBook`. That is what keeps the two from disagreeing: the
       * ledger whose categories are read here is exactly the ledger the entry will be filed in,
       * rather than whichever one the server happens to think "the" ledger is.
       */
      const bookId = request.book!.bookId;

      const categories = await prisma.category.findMany({
        where: { bookId },
        orderBy: [{ kind: "asc" }, { sortOrder: "asc" }],
        select: { id: true, name: true, kind: true, isArchived: true },
      });

      const spoken = parseSpokenEntryWithCategory(result.text, categories);

      return transcribeResponseSchema.parse({
        text: result.text,
        amount: spoken.amount,
        kind: spoken.kind,
        note: spoken.note,
        categoryId: spoken.categoryId,
        categoryMatched: spoken.categoryMatched,
        audioSeconds: result.audioSeconds,
        seconds: result.seconds,
      });
    } catch (error) {
      if (error instanceof TranscriptionRejected) {
        /**
         * The audio was the problem, and the message is already written for the
         * user by the sidecar. 413 for length, 400 for the rest — the status
         * matters to anything that retries automatically, and nothing here
         * should.
         */
        if (error.reason === "audio_too_long") {
          throw tooManyRequests("audio_too_long", error.message);
        }

        throw badRequest(error.reason, error.message);
      }

      throw error;
    }
  });
}

/**
 * Whether the first bytes look like a container a browser would record.
 *
 * Deliberately permissive about the *rest* of the file: the goal is to catch "a
 * JPEG was sent to the speech endpoint", not to re-implement a demuxer that PyAV
 * already has. Two families, because those are the two the browsers produce —
 * `ftyp` for Safari's `audio/mp4`, and the EBML header for Chrome's `audio/webm`
 * or `audio/ogg`.
 */
function looksLikeAudio(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;

  // MP4 family: a box length, then `ftyp`.
  if (buffer.toString("ascii", 4, 8) === "ftyp") return true;

  // WebM / Matroska: EBML magic.
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return true;
  }

  // Ogg: `OggS`.
  if (buffer.toString("ascii", 0, 4) === "OggS") return true;

  // WAV: `RIFF` then `WAVE`.
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE") {
    return true;
  }

  return false;
}
