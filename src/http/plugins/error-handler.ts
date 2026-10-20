import type { FastifyError, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { AppError } from '../../lib/errors.js';

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown; requestId: string };
}

/** Every error leaves the API in the same `{ error: { code, message, ... } }` shape. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const requestId = String(request.id);

    if (hasZodFastifySchemaValidationErrors(error)) {
      const details = error.validation.map((issue) => ({
        location: error.validationContext ?? 'request',
        path: issue.instancePath,
        message: issue.message,
      }));
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details,
          requestId,
        },
      } satisfies ErrorBody);
    }

    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details, requestId },
      } satisfies ErrorBody);
    }

    // Client errors raised by Fastify itself (malformed JSON, payload too large, rate limit).
    const statusCode = error.statusCode ?? 500;
    if (statusCode < 500) {
      return reply.code(statusCode).send({
        error: { code: error.code ?? 'BAD_REQUEST', message: error.message, requestId },
      } satisfies ErrorBody);
    }

    request.log.error({ err: error }, 'Unhandled error');
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong', requestId },
    } satisfies ErrorBody);
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`,
        requestId: String(request.id),
      },
    } satisfies ErrorBody),
  );
}
