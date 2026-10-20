import { createServer, type Server } from 'node:http';
import { Worker } from 'bullmq';
import { loadEnv } from './config/env.js';
import { createContainer } from './container.js';
import {
  QUEUE_NAMES,
  createConnectionOptions,
  type ScheduleJobData,
  type StepJobData,
} from './engine/queues.js';
import { createStepProcessor, type StepJobResult } from './engine/step-processor.js';
import { metricsRegistry } from './lib/metrics.js';
import { createLogger } from './lib/logger.js';
import { registerGracefulShutdown } from './lib/shutdown.js';

function startMetricsServer(port: number): Server {
  const server = createServer((request, response) => {
    if (request.url === '/metrics') {
      void metricsRegistry.metrics().then((body) => {
        response.writeHead(200, { 'content-type': metricsRegistry.contentType });
        response.end(body);
      });
      return;
    }
    response.writeHead(request.url === '/health/live' ? 200 : 404).end();
  });
  return server.listen(port);
}

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({
    name: 'flowforge-worker',
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV === 'development',
  });
  const container = createContainer(env, logger);
  const connection = createConnectionOptions(env.REDIS_URL);

  const stepWorker = new Worker<StepJobData, StepJobResult>(
    QUEUE_NAMES.steps,
    createStepProcessor({
      prisma: container.prisma,
      orchestrator: container.orchestrator,
      executors: container.executors,
      logger: logger.child({ component: 'step-worker' }),
    }),
    { connection, prefix: env.QUEUE_PREFIX, concurrency: env.WORKER_CONCURRENCY },
  );

  const scheduleWorker = new Worker<ScheduleJobData>(
    QUEUE_NAMES.schedules,
    async (job) => {
      // The scheduler job id is unique per tick, so a redelivered tick never creates a second run.
      const { run } = await container.runService.trigger(job.data.workflowId, {
        trigger: 'CRON',
        idempotencyKey: `cron:${job.id}`,
      });
      return { runId: run.id };
    },
    { connection, prefix: env.QUEUE_PREFIX, concurrency: 5 },
  );

  for (const worker of [stepWorker, scheduleWorker]) {
    worker.on('error', (error) => logger.error({ err: error, queue: worker.name }, 'Worker error'));
  }
  scheduleWorker.on('failed', (job, error) =>
    logger.warn({ err: error, workflowId: job?.data.workflowId }, 'Scheduled trigger failed'),
  );

  await container.schedules.reconcile(await container.prisma.workflow.findMany());
  const metricsServer = startMetricsServer(env.WORKER_METRICS_PORT);

  registerGracefulShutdown(logger, [
    // close() waits for active jobs to finish, so deploys never cut a step in half.
    () => Promise.all([stepWorker.close(), scheduleWorker.close()]).then(() => undefined),
    () => new Promise<void>((resolve) => metricsServer.close(() => resolve())),
    () => container.dispose(),
  ]);

  logger.info(
    { concurrency: env.WORKER_CONCURRENCY, metricsPort: env.WORKER_METRICS_PORT },
    'Worker started',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`Failed to start worker: ${String(error)}\n`);
  process.exit(1);
});
