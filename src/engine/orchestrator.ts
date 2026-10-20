import type { PrismaClient, RunStatus } from '@prisma/client';
import type { Logger } from '../lib/logger.js';
import { runsFinishedTotal } from '../lib/metrics.js';
import { toJsonValue } from '../lib/prisma.js';
import { findLeafSteps, findReadySteps } from './dag.js';
import { parseWorkflowDefinition, type StepDefinition } from './definition.js';
import { getEnqueueDelayMs } from './executors/registry.js';
import type { ExecutorRegistry } from './executors/types.js';
import { buildStepJobId, type StepQueue } from './queues.js';

const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export interface StepFailure {
  runId: string;
  stepKey: string;
  error: string;
  attempts: number;
  payload: unknown;
}

export interface Orchestrator {
  /** Enqueues every step whose dependencies are satisfied and completes the run when done. */
  advance(runId: string): Promise<void>;
  /** Marks the step and run as failed, skips pending steps and records a dead letter. */
  failRun(failure: StepFailure): Promise<void>;
}

export interface OrchestratorDeps {
  prisma: PrismaClient;
  stepQueue: StepQueue;
  executors: ExecutorRegistry;
  logger: Logger;
}

/**
 * The orchestrator is stateless: every decision is derived from the database,
 * so any API or worker process can call it, any number of times.
 */
export function createOrchestrator({
  prisma,
  stepQueue,
  executors,
  logger,
}: OrchestratorDeps): Orchestrator {
  async function enqueueStep(runId: string, step: StepDefinition): Promise<void> {
    // Add first, then mark QUEUED. The deterministic job id deduplicates
    // concurrent calls, and a crash in between leaves a job that still runs.
    await stepQueue.add(
      step.type,
      { runId, stepKey: step.key },
      {
        jobId: buildStepJobId(runId, step.key),
        attempts: step.retry.maxAttempts,
        backoff: { type: step.retry.backoff, delay: step.retry.delayMs },
        delay: getEnqueueDelayMs(executors, step),
      },
    );
    await prisma.stepRun.updateMany({
      where: { runId, stepKey: step.key, status: 'PENDING' },
      data: { status: 'QUEUED' },
    });
  }

  async function completeRun(runId: string, output: Record<string, unknown>): Promise<void> {
    const { count } = await prisma.workflowRun.updateMany({
      where: { id: runId, status: 'RUNNING' },
      data: { status: 'SUCCEEDED', output: toJsonValue(output), finishedAt: new Date() },
    });
    if (count === 1) {
      runsFinishedTotal.inc({ status: 'SUCCEEDED' });
      logger.info({ runId }, 'Workflow run succeeded');
    }
  }

  return {
    async advance(runId) {
      const run = await prisma.workflowRun.findUnique({
        where: { id: runId },
        include: { steps: true },
      });
      if (!run || isTerminalRunStatus(run.status)) return;

      if (run.status === 'PENDING') {
        await prisma.workflowRun.updateMany({
          where: { id: runId, status: 'PENDING' },
          data: { status: 'RUNNING', startedAt: new Date() },
        });
      }

      const definition = parseWorkflowDefinition(run.definition);
      const statusByKey = new Map(run.steps.map((step) => [step.stepKey, step.status]));
      const readyKeys = findReadySteps(definition.steps, (key) => statusByKey.get(key));

      for (const key of readyKeys) {
        const step = definition.steps.find((candidate) => candidate.key === key);
        if (step) await enqueueStep(runId, step);
      }

      const allSucceeded = run.steps.every((step) => step.status === 'SUCCEEDED');
      if (readyKeys.length === 0 && allSucceeded) {
        const outputByKey = new Map(run.steps.map((step) => [step.stepKey, step.output]));
        const output = Object.fromEntries(
          findLeafSteps(definition.steps).map((key) => [key, outputByKey.get(key) ?? null]),
        );
        await completeRun(runId, output);
      }
    },

    async failRun({ runId, stepKey, error, attempts, payload }) {
      const now = new Date();
      const [, runUpdate] = await prisma.$transaction([
        prisma.stepRun.updateMany({
          where: { runId, stepKey },
          data: { status: 'FAILED', error, attempts, finishedAt: now },
        }),
        prisma.workflowRun.updateMany({
          where: { id: runId, status: { in: ['PENDING', 'RUNNING'] } },
          data: { status: 'FAILED', error: `Step '${stepKey}' failed: ${error}`, finishedAt: now },
        }),
        prisma.stepRun.updateMany({
          where: { runId, status: { in: ['PENDING', 'QUEUED'] } },
          data: { status: 'SKIPPED', finishedAt: now },
        }),
        prisma.deadLetter.create({
          data: { runId, stepKey, error, attempts, payload: toJsonValue(payload) },
        }),
      ]);

      if (runUpdate.count === 1) runsFinishedTotal.inc({ status: 'FAILED' });
      logger.warn({ runId, stepKey, attempts, error }, 'Workflow run failed');
    },
  };
}
