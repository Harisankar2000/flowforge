/**
 * End-to-end tests against real PostgreSQL and Redis (see docker-compose.yml).
 * The API is exercised through fastify.inject and steps run on an in-process worker.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { createContainer, type Container } from '../../src/container.js';
import { QUEUE_NAMES, createConnectionOptions, type StepJobData } from '../../src/engine/queues.js';
import { createStepProcessor } from '../../src/engine/step-processor.js';
import { buildApp } from '../../src/http/app.js';
import { createLogger } from '../../src/lib/logger.js';

const API_KEY = 'integration-test-key';
const headers = { 'x-api-key': API_KEY };

interface TargetState {
  failuresRemaining: number;
  received: Array<{ path: string; body: unknown }>;
}

let container: Container;
let app: FastifyInstance;
let worker: Worker<StepJobData>;
let target: Server;
let targetUrl: string;
const targetState: TargetState = { failuresRemaining: 0, received: [] };

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : null;
}

function startTargetServer(): Promise<Server> {
  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    targetState.received.push({ path: request.url ?? '', body });

    if (request.url === '/flaky' && targetState.failuresRemaining > 0) {
      targetState.failuresRemaining -= 1;
      response.writeHead(503).end();
      return;
    }

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify(
        request.url === '/users/7' ? { id: 7, email: 'dev@example.com' } : { ok: true },
      ),
    );
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function createWorkflow(definition: unknown): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/workflows',
    headers,
    payload: { name: `wf-${randomUUID()}`, definition },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

async function triggerRun(
  workflowId: string,
  input: Record<string, unknown> = {},
  idempotencyKey?: string,
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/workflows/${workflowId}/runs`,
    headers: { ...headers, ...(idempotencyKey && { 'idempotency-key': idempotencyKey }) },
    payload: { input },
  });
}

interface RunBody {
  id: string;
  status: string;
  output: Record<string, unknown> | null;
  steps: Array<{ key: string; status: string; attempts: number; error: string | null }>;
}

async function waitForRun(runId: string, statuses: string[], timeoutMs = 15_000): Promise<RunBody> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await app.inject({ method: 'GET', url: `/api/v1/runs/${runId}`, headers });
    const run = response.json<RunBody>();
    if (statuses.includes(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`Run ${runId} stuck in ${run.status}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  const env = loadEnv({
    ...process.env,
    NODE_ENV: 'test',
    API_KEYS: API_KEY,
    QUEUE_PREFIX: `flowforge-test-${randomUUID()}`,
  });
  const logger = createLogger({ name: 'test', level: 'silent', pretty: false });
  container = createContainer(env, logger);
  app = await buildApp(container);

  worker = new Worker<StepJobData>(
    QUEUE_NAMES.steps,
    createStepProcessor({
      prisma: container.prisma,
      orchestrator: container.orchestrator,
      executors: container.executors,
      logger,
    }),
    {
      connection: createConnectionOptions(env.REDIS_URL),
      prefix: env.QUEUE_PREFIX,
      concurrency: 5,
    },
  );

  target = await startTargetServer();
  targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await worker?.close();
  await app?.close();
  await container?.queues.steps.obliterate({ force: true });
  await container?.queues.schedules.obliterate({ force: true });
  await container?.dispose();
  await new Promise((resolve) => target?.close(resolve));
});

beforeEach(async () => {
  targetState.failuresRemaining = 0;
  targetState.received = [];
  await container.prisma.workflow.deleteMany();
});

describe('workflow engine', () => {
  it('runs a DAG in dependency order and passes outputs between steps', async () => {
    const workflowId = await createWorkflow({
      steps: [
        { key: 'fetchUser', type: 'http', config: { url: `${targetUrl}/users/{{input.userId}}` } },
        { key: 'audit', type: 'log', config: { message: 'run {{run.id}} started' } },
        {
          key: 'notify',
          type: 'http',
          dependsOn: ['fetchUser', 'audit'],
          config: {
            method: 'POST',
            url: `${targetUrl}/notify`,
            body: {
              to: '{{steps.fetchUser.output.body.email}}',
              user: '{{steps.fetchUser.output.body}}',
            },
          },
        },
      ],
    });

    const response = await triggerRun(workflowId, { userId: 7 });
    expect(response.statusCode).toBe(202);

    const run = await waitForRun(response.json<RunBody>().id, ['SUCCEEDED', 'FAILED']);

    expect(run.status).toBe('SUCCEEDED');
    expect(run.steps.map((step) => step.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);
    expect(targetState.received.map((request) => request.path)).toEqual(['/users/7', '/notify']);
    expect(targetState.received[1]?.body).toEqual({
      to: 'dev@example.com',
      user: { id: 7, email: 'dev@example.com' },
    });
    expect(Object.keys(run.output ?? {})).toEqual(['notify']);
  });

  it('retries transient failures with backoff and then succeeds', async () => {
    targetState.failuresRemaining = 2;
    const workflowId = await createWorkflow({
      steps: [
        {
          key: 'flaky',
          type: 'http',
          retry: { maxAttempts: 3, backoff: 'fixed', delayMs: 50 },
          config: { url: `${targetUrl}/flaky` },
        },
      ],
    });

    const run = await waitForRun((await triggerRun(workflowId)).json<RunBody>().id, [
      'SUCCEEDED',
      'FAILED',
    ]);

    expect(run.status).toBe('SUCCEEDED');
    expect(run.steps[0]?.attempts).toBe(3);
  });

  it('dead-letters a step that exhausts its retries and resumes on retry', async () => {
    targetState.failuresRemaining = 2;
    const workflowId = await createWorkflow({
      steps: [
        { key: 'prepare', type: 'log', config: { message: 'prepare' } },
        {
          key: 'flaky',
          type: 'http',
          dependsOn: ['prepare'],
          retry: { maxAttempts: 2, backoff: 'fixed', delayMs: 50 },
          config: { url: `${targetUrl}/flaky` },
        },
        { key: 'after', type: 'log', dependsOn: ['flaky'], config: { message: 'after' } },
      ],
    });

    const failed = await waitForRun((await triggerRun(workflowId)).json<RunBody>().id, [
      'SUCCEEDED',
      'FAILED',
    ]);
    expect(failed.status).toBe('FAILED');
    expect(failed.steps.map((step) => step.status)).toEqual(['SUCCEEDED', 'FAILED', 'SKIPPED']);

    const deadLetters = await app.inject({ method: 'GET', url: '/api/v1/dead-letters', headers });
    expect(deadLetters.json<{ items: Array<{ runId: string }> }>().items).toEqual(
      expect.arrayContaining([expect.objectContaining({ runId: failed.id, stepKey: 'flaky' })]),
    );

    // The downstream service has recovered: retry resumes from the failed step only.
    const retry = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${failed.id}/retry`,
      headers,
    });
    expect(retry.statusCode).toBe(200);

    const recovered = await waitForRun(failed.id, ['SUCCEEDED', 'FAILED']);
    expect(recovered.status).toBe('SUCCEEDED');
    expect(targetState.received.filter((request) => request.path === '/flaky')).toHaveLength(3);
  });

  it('fails fast without retrying on a non-retryable error', async () => {
    const workflowId = await createWorkflow({
      steps: [
        {
          key: 'missing',
          type: 'http',
          retry: { maxAttempts: 5 },
          config: { url: `${targetUrl}/x`, expectStatus: [201] },
        },
      ],
    });

    const run = await waitForRun((await triggerRun(workflowId)).json<RunBody>().id, [
      'SUCCEEDED',
      'FAILED',
    ]);

    expect(run.status).toBe('FAILED');
    expect(run.steps[0]?.attempts).toBe(1);
  });

  it('returns the same run for a repeated idempotency key', async () => {
    const workflowId = await createWorkflow({
      steps: [{ key: 'a', type: 'log', config: { message: 'a' } }],
    });

    const [first, second] = await Promise.all([
      triggerRun(workflowId, {}, 'order-123'),
      triggerRun(workflowId, {}, 'order-123'),
    ]);

    expect(first.json<RunBody>().id).toBe(second.json<RunBody>().id);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 202]);
  });

  it('cancels a run waiting on a delay step', async () => {
    const workflowId = await createWorkflow({
      steps: [
        { key: 'wait', type: 'delay', config: { durationMs: 60_000 } },
        { key: 'after', type: 'log', dependsOn: ['wait'], config: { message: 'after' } },
      ],
    });
    const runId = (await triggerRun(workflowId)).json<RunBody>().id;

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/cancel`,
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<RunBody>().steps.map((step) => step.status)).toEqual([
      'CANCELLED',
      'CANCELLED',
    ]);
    expect(await container.queues.steps.getDelayedCount()).toBe(0);
  });
});

describe('API contract', () => {
  it('rejects requests without a valid API key', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/workflows' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('returns structured validation errors for an invalid DAG', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/workflows',
      headers,
      payload: {
        name: 'cyclic',
        definition: {
          steps: [
            { key: 'a', type: 'log', dependsOn: ['b'], config: { message: 'a' } },
            { key: 'b', type: 'log', dependsOn: ['a'], config: { message: 'b' } },
          ],
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain('Cycle detected between steps: a, b');
  });

  it('rejects duplicate workflow names with 409', async () => {
    const payload = {
      name: 'unique-name',
      definition: { steps: [{ key: 'a', type: 'log', config: { message: 'a' } }] },
    };
    await app.inject({ method: 'POST', url: '/api/v1/workflows', headers, payload });

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/workflows',
      headers,
      payload,
    });

    expect(duplicate.statusCode).toBe(409);
  });

  it('registers cron schedules and reports the next run time', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/workflows',
      headers,
      payload: {
        name: 'nightly',
        schedule: { cron: '0 2 * * *', timezone: 'Asia/Kolkata' },
        definition: { steps: [{ key: 'a', type: 'log', config: { message: 'a' } }] },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      schedule: { cron: '0 2 * * *', timezone: 'Asia/Kolkata' },
    });
    expect(await container.queues.schedules.getJobSchedulersCount()).toBe(1);
  });

  it('exposes public health and metrics endpoints', async () => {
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });

    expect(ready.json()).toEqual({ status: 'ok', dependencies: { database: 'up', redis: 'up' } });
    expect(metrics.body).toContain('flowforge_runs_triggered_total');
  });
});
