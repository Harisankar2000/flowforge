import { randomUUID } from 'node:crypto';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Container } from '../container.js';
import { deadLetterRoutes } from '../modules/dead-letters/dead-letter.routes.js';
import { healthRoutes } from '../modules/health/health.routes.js';
import { runRoutes } from '../modules/runs/run.routes.js';
import { workflowRoutes } from '../modules/workflows/workflow.routes.js';
import { registerApiKeyAuth } from './plugins/auth.js';
import { registerErrorHandling } from './plugins/error-handler.js';
import { registerSwagger } from './plugins/swagger.js';

export type AppContainer = Pick<
  Container,
  'env' | 'logger' | 'prisma' | 'redis' | 'workflowService' | 'runService'
>;

export async function buildApp(container: AppContainer): Promise<FastifyInstance> {
  const { env, logger, prisma, redis } = container;

  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    genReqId: (request) => {
      const incoming = request.headers['x-request-id'];
      return typeof incoming === 'string' && incoming.length <= 128 ? incoming : randomUUID();
    },
    bodyLimit: 1_048_576,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  registerErrorHandling(app);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      const apiKey = request.headers['x-api-key'];
      return typeof apiKey === 'string' ? `key:${apiKey}` : `ip:${request.ip}`;
    },
  });
  await registerSwagger(app);
  registerApiKeyAuth(app, env.API_KEYS);

  await app.register(
    healthRoutes({
      checks: {
        database: async () => {
          await prisma.$queryRaw`SELECT 1`;
        },
        redis: async () => {
          await redis.ping();
        },
      },
    }),
  );

  await app.register(
    async (api) => {
      await api.register(workflowRoutes(container.workflowService));
      await api.register(runRoutes(container.runService));
      await api.register(deadLetterRoutes(prisma));
    },
    { prefix: '/api/v1' },
  );

  return app;
}
