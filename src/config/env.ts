import 'dotenv/config';
import { z } from 'zod';

const csvList = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),

  API_KEYS: csvList,
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),

  QUEUE_PREFIX: z.string().min(1).default('flowforge'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(500).default(10),
  WORKER_METRICS_PORT: z.coerce.number().int().positive().default(9100),

  HTTP_STEP_ALLOWED_HOSTS: csvList,
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
