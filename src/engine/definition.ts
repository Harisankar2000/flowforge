import { z } from 'zod';
import { validateDag } from './dag.js';

export const STEP_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
export const MAX_STEP_TIMEOUT_MS = 15 * 60_000;
export const MAX_DELAY_MS = 7 * 24 * 60 * 60_000;

const retryPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(10).default(3),
    backoff: z.enum(['fixed', 'exponential']).default('exponential'),
    delayMs: z.number().int().min(0).max(3_600_000).default(1_000),
  })
  .prefault({});

const baseStepShape = {
  key: z.string().regex(STEP_KEY_PATTERN, 'Use letters, digits, "_" or "-" (max 64 chars)'),
  dependsOn: z.array(z.string()).max(50).default([]),
  retry: retryPolicySchema,
  timeoutMs: z.number().int().min(100).max(MAX_STEP_TIMEOUT_MS).default(30_000),
};

export const httpStepSchema = z.object({
  ...baseStepShape,
  type: z.literal('http'),
  config: z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
    /** May contain templates such as {{input.baseUrl}}, so it is validated at execution time. */
    url: z.string().min(1).max(2_048),
    headers: z.record(z.string(), z.string()).default({}),
    body: z.unknown().optional(),
    expectStatus: z.array(z.number().int().min(100).max(599)).min(1).optional(),
  }),
});

export const delayStepSchema = z.object({
  ...baseStepShape,
  type: z.literal('delay'),
  config: z.object({
    durationMs: z.number().int().min(0).max(MAX_DELAY_MS),
  }),
});

export const logStepSchema = z.object({
  ...baseStepShape,
  type: z.literal('log'),
  config: z.object({
    message: z.string().min(1).max(2_000),
    level: z.enum(['info', 'warn', 'error']).default('info'),
  }),
});

export const stepDefinitionSchema = z.discriminatedUnion('type', [
  httpStepSchema,
  delayStepSchema,
  logStepSchema,
]);

export const workflowDefinitionSchema = z
  .object({
    steps: z.array(stepDefinitionSchema).min(1).max(100),
  })
  .superRefine((definition, ctx) => {
    const result = validateDag(definition.steps);
    if (!result.ok) {
      for (const message of result.errors) {
        ctx.addIssue({ code: 'custom', message, path: ['steps'] });
      }
    }
  });

export type StepDefinition = z.infer<typeof stepDefinitionSchema>;
export type StepType = StepDefinition['type'];
export type StepConfig<T extends StepType> = Extract<StepDefinition, { type: T }>['config'];
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

/** Parses a definition read back from the database (already validated on write). */
export function parseWorkflowDefinition(value: unknown): WorkflowDefinition {
  return workflowDefinitionSchema.parse(value);
}

export function findStep(definition: WorkflowDefinition, key: string): StepDefinition {
  const step = definition.steps.find((candidate) => candidate.key === key);
  if (!step) throw new Error(`Step '${key}' is not part of the workflow definition`);
  return step;
}
