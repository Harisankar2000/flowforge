import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { WorkflowService } from './workflow.service.js';
import {
  createWorkflowBodySchema,
  listWorkflowsQuerySchema,
  updateWorkflowBodySchema,
  workflowParamsSchema,
} from './workflow.schemas.js';

const tags = ['Workflows'];

export function workflowRoutes(service: WorkflowService): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/workflows',
      {
        schema: {
          tags,
          summary: 'Create a workflow (optionally with a cron schedule)',
          body: createWorkflowBodySchema,
        },
      },
      async (request, reply) => reply.code(201).send(await service.create(request.body)),
    );

    app.get(
      '/workflows',
      { schema: { tags, summary: 'List workflows', querystring: listWorkflowsQuerySchema } },
      async (request) => service.list(request.query),
    );

    app.get(
      '/workflows/:workflowId',
      { schema: { tags, summary: 'Get a workflow', params: workflowParamsSchema } },
      async (request) => service.get(request.params.workflowId),
    );

    app.patch(
      '/workflows/:workflowId',
      {
        schema: {
          tags,
          summary: 'Update a workflow. Changing the definition bumps its version.',
          params: workflowParamsSchema,
          body: updateWorkflowBodySchema,
        },
      },
      async (request) => service.update(request.params.workflowId, request.body),
    );

    app.delete(
      '/workflows/:workflowId',
      { schema: { tags, summary: 'Delete a workflow and its runs', params: workflowParamsSchema } },
      async (request, reply) => {
        await service.delete(request.params.workflowId);
        return reply.code(204).send();
      },
    );
  };
}
