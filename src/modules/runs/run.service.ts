import type { StepRun, TriggerType, WorkflowRun } from '@prisma/client';
import { parseWorkflowDefinition } from '../../engine/definition.js';
import type { Orchestrator } from '../../engine/orchestrator.js';
import { buildStepJobId, type StepQueue } from '../../engine/queues.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import { runsFinishedTotal, runsTriggeredTotal } from '../../lib/metrics.js';
import { buildPage, type Page } from '../../lib/pagination.js';
import { isUniqueConstraintError } from '../../lib/prisma.js';
import type { WorkflowService } from '../workflows/workflow.service.js';
import type { RunRepository, RunWithSteps } from './run.repository.js';
import type { ListRunsQuery } from './run.schemas.js';

export interface TriggerOptions {
  input?: Record<string, unknown>;
  idempotencyKey?: string;
  trigger: TriggerType;
}

export interface TriggerResult {
  run: RunView;
  /** False when an existing run was returned for a repeated idempotency key. */
  created: boolean;
}

export type RunView = ReturnType<typeof toRunView>;

export interface RunService {
  trigger(workflowId: string, options: TriggerOptions): Promise<TriggerResult>;
  get(runId: string): Promise<RunView>;
  listForWorkflow(workflowId: string, query: ListRunsQuery): Promise<Page<RunSummaryView>>;
  cancel(runId: string): Promise<RunView>;
  retry(runId: string): Promise<RunView>;
}

export interface RunServiceDeps {
  runs: RunRepository;
  workflows: WorkflowService;
  orchestrator: Orchestrator;
  stepQueue: StepQueue;
  logger: Logger;
}

const toIso = (date: Date | null): string | null => date?.toISOString() ?? null;

export function toRunSummaryView(run: WorkflowRun) {
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    status: run.status,
    trigger: run.trigger,
    idempotencyKey: run.idempotencyKey,
    error: run.error,
    createdAt: run.createdAt.toISOString(),
    startedAt: toIso(run.startedAt),
    finishedAt: toIso(run.finishedAt),
  };
}

export type RunSummaryView = ReturnType<typeof toRunSummaryView>;

function toStepView(step: StepRun) {
  return {
    key: step.stepKey,
    type: step.type,
    status: step.status,
    attempts: step.attempts,
    input: step.input,
    output: step.output,
    error: step.error,
    startedAt: toIso(step.startedAt),
    finishedAt: toIso(step.finishedAt),
  };
}

export function toRunView(run: RunWithSteps) {
  // Steps are inserted in one statement, so present them in definition order instead.
  const order = new Map(
    parseWorkflowDefinition(run.definition).steps.map((step, index) => [step.key, index]),
  );
  const steps = [...run.steps].sort(
    (a, b) => (order.get(a.stepKey) ?? 0) - (order.get(b.stepKey) ?? 0),
  );

  return {
    ...toRunSummaryView(run),
    input: run.input,
    output: run.output,
    steps: steps.map(toStepView),
  };
}

export function createRunService({
  runs,
  workflows,
  orchestrator,
  stepQueue,
  logger,
}: RunServiceDeps): RunService {
  async function getEntity(runId: string): Promise<RunWithSteps> {
    const run = await runs.findById(runId);
    if (!run) throw new NotFoundError('Run', runId);
    return run;
  }

  async function findExisting(workflowId: string, key: string | undefined) {
    return key ? runs.findByIdempotencyKey(workflowId, key) : null;
  }

  return {
    async trigger(workflowId, { input = {}, idempotencyKey, trigger }) {
      const workflow = await workflows.getEntity(workflowId);
      if (!workflow.isActive) throw new ConflictError(`Workflow '${workflowId}' is inactive`);

      const existing = await findExisting(workflowId, idempotencyKey);
      if (existing) return { run: toRunView(existing), created: false };

      let run: RunWithSteps;
      try {
        run = await runs.createWithSteps({
          workflowId,
          workflowVersion: workflow.version,
          definition: parseWorkflowDefinition(workflow.definition),
          trigger,
          input,
          idempotencyKey,
        });
      } catch (error) {
        // Two concurrent requests with the same key: the loser returns the winner's run.
        const winner = isUniqueConstraintError(error)
          ? await findExisting(workflowId, idempotencyKey)
          : null;
        if (winner) return { run: toRunView(winner), created: false };
        throw error;
      }

      runsTriggeredTotal.inc({ trigger });
      logger.info({ runId: run.id, workflowId, trigger }, 'Workflow run triggered');

      await orchestrator.advance(run.id);
      return { run: toRunView(await getEntity(run.id)), created: true };
    },

    async get(runId) {
      return toRunView(await getEntity(runId));
    },

    async listForWorkflow(workflowId, query) {
      await workflows.getEntity(workflowId);
      const { items, total } = await runs.findManyForWorkflow(workflowId, query);
      return buildPage(items.map(toRunSummaryView), total, query);
    },

    async cancel(runId) {
      const run = await getEntity(runId);
      const cancelled = await runs.markCancelled(runId);
      if (!cancelled) throw new ConflictError(`Run '${runId}' is already ${run.status}`);

      // Best effort: waiting/delayed jobs are removed; an active job sees the
      // cancelled run when it finishes and does not advance the workflow.
      await Promise.all(
        run.steps
          .filter((step) => step.status === 'PENDING' || step.status === 'QUEUED')
          .map((step) => stepQueue.remove(buildStepJobId(runId, step.stepKey))),
      );

      runsFinishedTotal.inc({ status: 'CANCELLED' });
      logger.info({ runId }, 'Workflow run cancelled');
      return toRunView(await getEntity(runId));
    },

    async retry(runId) {
      const run = await getEntity(runId);
      if (run.status !== 'FAILED') {
        throw new ConflictError(`Only FAILED runs can be retried; run is ${run.status}`);
      }

      const stepKeys = run.steps
        .filter((step) => step.status !== 'SUCCEEDED')
        .map((step) => step.stepKey);

      // Old failed jobs keep their ids in Redis; remove them so re-enqueueing is not deduplicated.
      await Promise.all(stepKeys.map((key) => stepQueue.remove(buildStepJobId(runId, key))));

      const reset = await runs.resetForRetry(runId, stepKeys);
      if (!reset) throw new ConflictError(`Run '${runId}' changed state during retry`);

      logger.info({ runId, steps: stepKeys }, 'Retrying workflow run from failed steps');
      await orchestrator.advance(runId);
      return toRunView(await getEntity(runId));
    },
  };
}
