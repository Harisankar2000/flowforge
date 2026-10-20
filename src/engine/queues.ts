import { Queue, type ConnectionOptions } from 'bullmq';

export const QUEUE_NAMES = {
  steps: 'workflow-steps',
  schedules: 'workflow-schedules',
} as const;

export interface StepJobData {
  runId: string;
  stepKey: string;
}

export interface ScheduleJobData {
  workflowId: string;
}

export type StepQueue = Queue<StepJobData>;
export type ScheduleQueue = Queue<ScheduleJobData>;

export interface Queues {
  steps: StepQueue;
  schedules: ScheduleQueue;
}

export interface QueueSettings {
  redisUrl: string;
  prefix: string;
}

/** BullMQ requires `maxRetriesPerRequest: null` for blocking worker connections. */
export function createConnectionOptions(redisUrl: string): ConnectionOptions {
  return { url: redisUrl, maxRetriesPerRequest: null };
}

/**
 * Deterministic job id: enqueueing the same step twice is a no-op in BullMQ,
 * which makes the orchestrator safe to call concurrently and after crashes.
 */
export function buildStepJobId(runId: string, stepKey: string): string {
  return `${runId}__${stepKey}`;
}

export function buildSchedulerId(workflowId: string): string {
  return `workflow__${workflowId}`;
}

export function createQueues({ redisUrl, prefix }: QueueSettings): Queues {
  const connection = createConnectionOptions(redisUrl);

  return {
    steps: new Queue<StepJobData>(QUEUE_NAMES.steps, {
      connection,
      prefix,
      defaultJobOptions: {
        removeOnComplete: { age: 24 * 3600, count: 10_000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    }),
    schedules: new Queue<ScheduleJobData>(QUEUE_NAMES.schedules, {
      connection,
      prefix,
      defaultJobOptions: {
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 1_000 },
      },
    }),
  };
}

export async function closeQueues(queues: Queues): Promise<void> {
  await Promise.all([queues.steps.close(), queues.schedules.close()]);
}
