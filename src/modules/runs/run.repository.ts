import type { Prisma, PrismaClient, StepRun, TriggerType, WorkflowRun } from '@prisma/client';
import type { WorkflowDefinition } from '../../engine/definition.js';
import { toSkipTake } from '../../lib/pagination.js';
import { toJsonValue } from '../../lib/prisma.js';
import type { ListRunsQuery } from './run.schemas.js';

export type RunWithSteps = WorkflowRun & { steps: StepRun[] };

export interface CreateRunInput {
  workflowId: string;
  workflowVersion: number;
  definition: WorkflowDefinition;
  trigger: TriggerType;
  input: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface RunRepository {
  createWithSteps(input: CreateRunInput): Promise<RunWithSteps>;
  findById(id: string): Promise<RunWithSteps | null>;
  findByIdempotencyKey(workflowId: string, key: string): Promise<RunWithSteps | null>;
  findManyForWorkflow(
    workflowId: string,
    query: ListRunsQuery,
  ): Promise<{ items: WorkflowRun[]; total: number }>;
  markCancelled(id: string): Promise<boolean>;
  resetForRetry(id: string, stepKeys: string[]): Promise<boolean>;
}

const withSteps = { steps: true } satisfies Prisma.WorkflowRunInclude;

export function createRunRepository(prisma: PrismaClient): RunRepository {
  return {
    createWithSteps: ({ definition, input, ...run }) =>
      prisma.workflowRun.create({
        data: {
          ...run,
          definition: toJsonValue(definition),
          input: toJsonValue(input),
          steps: {
            create: definition.steps.map((step) => ({ stepKey: step.key, type: step.type })),
          },
        },
        include: withSteps,
      }),

    findById: (id) => prisma.workflowRun.findUnique({ where: { id }, include: withSteps }),

    findByIdempotencyKey: (workflowId, idempotencyKey) =>
      prisma.workflowRun.findUnique({
        where: { workflowId_idempotencyKey: { workflowId, idempotencyKey } },
        include: withSteps,
      }),

    async findManyForWorkflow(workflowId, query) {
      const where: Prisma.WorkflowRunWhereInput = {
        workflowId,
        ...(query.status && { status: query.status }),
      };
      const [items, total] = await prisma.$transaction([
        prisma.workflowRun.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          ...toSkipTake(query),
        }),
        prisma.workflowRun.count({ where }),
      ]);
      return { items, total };
    },

    async markCancelled(id) {
      const now = new Date();
      const [runUpdate] = await prisma.$transaction([
        prisma.workflowRun.updateMany({
          where: { id, status: { in: ['PENDING', 'RUNNING'] } },
          data: { status: 'CANCELLED', finishedAt: now },
        }),
        prisma.stepRun.updateMany({
          where: { runId: id, status: { in: ['PENDING', 'QUEUED'] } },
          data: { status: 'CANCELLED', finishedAt: now },
        }),
      ]);
      return runUpdate.count === 1;
    },

    async resetForRetry(id, stepKeys) {
      const [runUpdate] = await prisma.$transaction([
        prisma.workflowRun.updateMany({
          where: { id, status: 'FAILED' },
          data: { status: 'RUNNING', error: null, finishedAt: null },
        }),
        prisma.stepRun.updateMany({
          where: { runId: id, stepKey: { in: stepKeys } },
          data: {
            status: 'PENDING',
            attempts: 0,
            error: null,
            output: toJsonValue(null),
            startedAt: null,
            finishedAt: null,
          },
        }),
        prisma.deadLetter.updateMany({
          where: { runId: id, resolvedAt: null },
          data: { resolvedAt: new Date() },
        }),
      ]);
      return runUpdate.count === 1;
    },
  };
}
