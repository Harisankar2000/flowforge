import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination.js';

export const RUN_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;

export const triggerRunBodySchema = z
  .object({
    input: z.record(z.string(), z.unknown()).default({}),
  })
  .prefault({});

export const triggerRunHeadersSchema = z.object({
  'idempotency-key': z.string().trim().min(1).max(200).optional(),
});

export const runParamsSchema = z.object({ runId: z.uuid() });

export const listRunsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(RUN_STATUSES).optional(),
});

export type TriggerRunBody = z.infer<typeof triggerRunBodySchema>;
export type ListRunsQuery = z.infer<typeof listRunsQuerySchema>;
