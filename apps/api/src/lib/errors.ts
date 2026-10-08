import { apiErrorSchema } from "@libellum/shared";
import type { FastifyError, FastifyInstance } from "fastify";
import { ZodError } from "zod";

/**
 * Errors that are safe to show to a user. Anything else becomes a generic
 * 500 with the detail written to the log instead of the response.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(code: string, message: string, details?: unknown): AppError {
  return new AppError(400, code, message, details);
}

export function unauthorized(code: string, message: string): AppError {
  return new AppError(401, code, message);
}

export function forbidden(code: string, message: string): AppError {
  return new AppError(403, code, message);
}

export function conflict(code: string, message: string): AppError {
  return new AppError(409, code, message);
}

export function tooManyRequests(code: string, message: string): AppError {
  return new AppError(429, code, message);
}

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send(
      apiErrorSchema.parse({
        code: "not_found",
        message: `找不到接口 ${request.method} ${request.url}`,
      }),
    );
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      request.log.info({ code: error.code, statusCode: error.statusCode }, "request rejected");
      void reply.status(error.statusCode).send({
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      });
      return;
    }

    if (error instanceof ZodError) {
      void reply.status(400).send({
        code: "validation_failed",
        message: error.issues[0]?.message ?? "请求参数不合法",
        details: error.issues,
      });
      return;
    }

    // Fastify's own errors (body parse failures, rate limiting, ...) already
    // carry a status code; anything >= 500 is ours and must not leak details.
    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;

    if (statusCode >= 500) {
      request.log.error({ err: error }, "unhandled error");
      void reply.status(500).send({ code: "internal_error", message: "服务暂时不可用，请稍后再试。" });
      return;
    }

    void reply.status(statusCode).send({
      code: error.code ?? "request_error",
      message: error.message,
    });
  });
}
