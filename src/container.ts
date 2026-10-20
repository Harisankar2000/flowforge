import type { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import type { Env } from './config/env.js';
import { createExecutorRegistry } from './engine/executors/registry.js';
import type { ExecutorRegistry } from './engine/executors/types.js';
import { createOrchestrator, type Orchestrator } from './engine/orchestrator.js';
import { closeQueues, createQueues, type Queues } from './engine/queues.js';
import { createScheduleManager, type ScheduleManager } from './engine/scheduler.js';
import type { Logger } from './lib/logger.js';
import { createPrismaClient } from './lib/prisma.js';
import { createRunRepository } from './modules/runs/run.repository.js';
import { createRunService, type RunService } from './modules/runs/run.service.js';
import { createWorkflowRepository } from './modules/workflows/workflow.repository.js';
import {
  createWorkflowService,
  type WorkflowService,
} from './modules/workflows/workflow.service.js';

export interface Container {
  env: Env;
  logger: Logger;
  prisma: PrismaClient;
  redis: Redis;
  queues: Queues;
  executors: ExecutorRegistry;
  orchestrator: Orchestrator;
  schedules: ScheduleManager;
  workflowService: WorkflowService;
  runService: RunService;
  dispose(): Promise<void>;
}

/** Composition root: the only place that knows how concrete implementations fit together. */
export function createContainer(env: Env, logger: Logger): Container {
  const prisma = createPrismaClient(env.DATABASE_URL);
  const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
  const queues = createQueues({ redisUrl: env.REDIS_URL, prefix: env.QUEUE_PREFIX });

  const executors = createExecutorRegistry({
    http: { allowedHosts: env.HTTP_STEP_ALLOWED_HOSTS },
  });
  const orchestrator = createOrchestrator({
    prisma,
    stepQueue: queues.steps,
    executors,
    logger: logger.child({ component: 'orchestrator' }),
  });
  const schedules = createScheduleManager(
    queues.schedules,
    logger.child({ component: 'scheduler' }),
  );

  const workflowService = createWorkflowService(createWorkflowRepository(prisma), schedules);
  const runService = createRunService({
    runs: createRunRepository(prisma),
    workflows: workflowService,
    orchestrator,
    stepQueue: queues.steps,
    logger: logger.child({ component: 'runs' }),
  });

  return {
    env,
    logger,
    prisma,
    redis,
    queues,
    executors,
    orchestrator,
    schedules,
    workflowService,
    runService,
    async dispose() {
      await closeQueues(queues);
      redis.disconnect();
      await prisma.$disconnect();
    },
  };
}
