import { z } from 'zod';
import { workflowDefinitionSchema } from '../../engine/definition.js';
import { isValidCron } from '../../engine/scheduler.js';
import { paginationQuerySchema } from '../../lib/pagination.js';

export const scheduleSchema = z
  .object({
    cron: z.string().trim().min(1).max(120),
    timezone: z.string().trim().min(1).max(64).default('UTC'),
  })
  .refine((schedule) => isValidCron(schedule.cron, schedule.timezone), {
    message: 'Invalid cron expression or timezone',
    path: ['cron'],
  });

const nameSchema = z.string().trim().min(1).max(120);
const descriptionSchema = z.string().trim().max(1_000);

export const createWorkflowBodySchema = z.object({
  name: nameSchema,
  description: descriptionSchema.optional(),
  definition: workflowDefinitionSchema,
  schedule: scheduleSchema.optional(),
  isActive: z.boolean().default(true),
});

/** Explicit (not `.partial()`) so defaults never overwrite fields on update. */
export const updateWorkflowBodySchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    definition: workflowDefinitionSchema.optional(),
    schedule: scheduleSchema.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Provide at least one field' });

export const workflowParamsSchema = z.object({ workflowId: z.uuid() });

export const listWorkflowsQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().min(1).max(120).optional(),
  isActive: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

export type CreateWorkflowBody = z.infer<typeof createWorkflowBodySchema>;
export type UpdateWorkflowBody = z.infer<typeof updateWorkflowBodySchema>;
export type ListWorkflowsQuery = z.infer<typeof listWorkflowsQuerySchema>;
