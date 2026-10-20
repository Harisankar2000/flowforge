import type { DeadLetter, PrismaClient } from '@prisma/client';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { buildPage, paginationQuerySchema, toSkipTake } from '../../lib/pagination.js';

const listDeadLettersQuerySchema = paginationQuerySchema.extend({
  resolved: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .default(false),
});

function toDeadLetterView(deadLetter: DeadLetter) {
  return {
    id: deadLetter.id,
    runId: deadLetter.runId,
    stepKey: deadLetter.stepKey,
    error: deadLetter.error,
    attempts: deadLetter.attempts,
    payload: deadLetter.payload,
    createdAt: deadLetter.createdAt.toISOString(),
    resolvedAt: deadLetter.resolvedAt?.toISOString() ?? null,
  };
}

/** Read-only view: dead letters are resolved by retrying their run (POST /runs/:id/retry). */
export function deadLetterRoutes(prisma: PrismaClient): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/dead-letters',
      {
        schema: {
          tags: ['Dead letters'],
          summary: 'List steps that exhausted their retries',
          querystring: listDeadLettersQuerySchema,
        },
      },
      async (request) => {
        const where = { resolvedAt: request.query.resolved ? { not: null } : null };
        const [items, total] = await prisma.$transaction([
          prisma.deadLetter.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            ...toSkipTake(request.query),
          }),
          prisma.deadLetter.count({ where }),
        ]);
        return buildPage(items.map(toDeadLetterView), total, request.query);
      },
    );
  };
}
