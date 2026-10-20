import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { workflowParamsSchema } from '../workflows/workflow.schemas.js';
import type { RunService } from './run.service.js';
import {
  listRunsQuerySchema,
  runParamsSchema,
  triggerRunBodySchema,
  triggerRunHeadersSchema,
} from './run.schemas.js';

const tags = ['Runs'];

export function runRoutes(service: RunService): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/workflows/:workflowId/runs',
      {
        schema: {
          tags,
          summary: 'Trigger a run. Send an Idempotency-Key header to make retries safe.',
          params: workflowParamsSchema,
          headers: triggerRunHeadersSchema,
          body: triggerRunBodySchema,
        },
      },
      async (request, reply) => {
        const { run, created } = await service.trigger(request.params.workflowId, {
          input: request.body.input,
          idempotencyKey: request.headers['idempotency-key'],
          trigger: 'MANUAL',
        });
        return reply.code(created ? 202 : 200).send(run);
      },
    );

    app.get(
      '/workflows/:workflowId/runs',
      {
        schema: {
          tags,
          summary: 'List runs of a workflow',
          params: workflowParamsSchema,
          querystring: listRunsQuerySchema,
        },
      },
      async (request) => service.listForWorkflow(request.params.workflowId, request.query),
    );

    app.get(
      '/runs/:runId',
      { schema: { tags, summary: 'Get a run with its step states', params: runParamsSchema } },
      async (request) => service.get(request.params.runId),
    );

    app.post(
      '/runs/:runId/cancel',
      { schema: { tags, summary: 'Cancel a pending or running run', params: runParamsSchema } },
      async (request) => service.cancel(request.params.runId),
    );

    app.post(
      '/runs/:runId/retry',
      {
        schema: {
          tags,
          summary: 'Retry a failed run from its failed step (successful steps are kept)',
          params: runParamsSchema,
        },
      },
      async (request) => service.retry(request.params.runId),
    );
  };
}
