import type { PrismaClient, StepRun, WorkflowRun } from '@prisma/client';
import { UnrecoverableError, type Job } from 'bullmq';
import { getErrorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { stepAttemptsTotal, stepDurationSeconds } from '../lib/metrics.js';
import { toJsonValue } from '../lib/prisma.js';
import { redactSensitive } from '../lib/redact.js';
import { findStep, parseWorkflowDefinition } from './definition.js';
import { NonRetryableStepError } from './errors.js';
import { executeStep } from './executors/registry.js';
import type { ExecutorRegistry } from './executors/types.js';
import { isTerminalRunStatus, type Orchestrator } from './orchestrator.js';
import type { StepJobData } from './queues.js';
import { renderTemplate, type TemplateContext } from './template.js';
import { runWithTimeout } from './timeout.js';

export interface StepProcessorDeps {
  prisma: PrismaClient;
  orchestrator: Orchestrator;
  executors: ExecutorRegistry;
  logger: Logger;
}

export interface StepJobResult {
  outcome: 'succeeded' | 'already-succeeded' | 'skipped';
}

export function buildTemplateContext(run: WorkflowRun & { steps: StepRun[] }): TemplateContext {
  return {
    input: run.input ?? {},
    run: { id: run.id, workflowId: run.workflowId },
    steps: Object.fromEntries(
      run.steps
        .filter((step) => step.status === 'SUCCEEDED')
        .map((step) => [step.stepKey, { output: step.output }]),
    ),
  };
}

/**
 * Processes one attempt of one step. Safe to re-run: BullMQ may redeliver a
 * job after a worker crash (stalled job), so completed steps are detected and
 * only the orchestration is repeated.
 */
export function createStepProcessor({
  prisma,
  orchestrator,
  executors,
  logger,
}: StepProcessorDeps) {
  return async function processStepJob(job: Job<StepJobData>): Promise<StepJobResult> {
    const { runId, stepKey } = job.data;
    const attempt = job.attemptsMade + 1;
    const log = logger.child({ runId, stepKey, attempt, jobId: job.id });

    const run = await prisma.workflowRun.findUnique({
      where: { id: runId },
      include: { steps: true },
    });
    const stepRun = run?.steps.find((step) => step.stepKey === stepKey);

    if (!run || !stepRun) {
      log.warn('Run or step no longer exists, discarding job');
      return { outcome: 'skipped' };
    }

    if (stepRun.status === 'SUCCEEDED') {
      await orchestrator.advance(runId);
      return { outcome: 'already-succeeded' };
    }

    if (isTerminalRunStatus(run.status)) {
      await prisma.stepRun.updateMany({
        where: { id: stepRun.id, status: { in: ['PENDING', 'QUEUED'] } },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      });
      log.info({ runStatus: run.status }, 'Run already finished, skipping step');
      return { outcome: 'skipped' };
    }

    const step = findStep(parseWorkflowDefinition(run.definition), stepKey);
    await prisma.stepRun.update({
      where: { id: stepRun.id },
      data: { status: 'RUNNING', attempts: attempt, startedAt: stepRun.startedAt ?? new Date() },
    });

    const stopTimer = stepDurationSeconds.startTimer({ type: step.type });
    try {
      const resolvedConfig = renderTemplate(step.config, buildTemplateContext(run));
      const output = await runWithTimeout(
        (signal) =>
          executeStep(executors, step, resolvedConfig, {
            runId,
            stepKey,
            attempt,
            signal,
            logger: log,
          }),
        step.timeoutMs,
      );

      await prisma.stepRun.updateMany({
        where: { id: stepRun.id, status: 'RUNNING' },
        data: {
          status: 'SUCCEEDED',
          input: toJsonValue(redactSensitive(resolvedConfig)),
          output: toJsonValue(output),
          error: null,
          finishedAt: new Date(),
        },
      });
      stepAttemptsTotal.inc({ type: step.type, outcome: 'succeeded' });
      log.info('Step succeeded');

      await orchestrator.advance(runId);
      return { outcome: 'succeeded' };
    } catch (error) {
      const message = getErrorMessage(error);
      const maxAttempts = job.opts.attempts ?? 1;
      const isFinal = error instanceof NonRetryableStepError || attempt >= maxAttempts;

      if (isFinal) {
        stepAttemptsTotal.inc({ type: step.type, outcome: 'failed' });
        await orchestrator.failRun({
          runId,
          stepKey,
          error: message,
          attempts: attempt,
          payload: { jobId: job.id, stepType: step.type, maxAttempts },
        });
        throw new UnrecoverableError(message);
      }

      stepAttemptsTotal.inc({ type: step.type, outcome: 'retrying' });
      await prisma.stepRun.updateMany({
        where: { id: stepRun.id, status: 'RUNNING' },
        data: { status: 'QUEUED', error: message },
      });
      log.warn({ err: error, maxAttempts }, 'Step attempt failed, will retry');
      throw error;
    } finally {
      stopTimer();
    }
  };
}
