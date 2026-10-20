import { pino, type Logger } from 'pino';

export type { Logger };

export interface LoggerOptions {
  level: string;
  pretty: boolean;
  name: string;
}

export function createLogger({ level, pretty, name }: LoggerOptions): Logger {
  return pino({
    name,
    level,
    redact: {
      paths: ['req.headers.authorization', 'req.headers["x-api-key"]'],
      censor: '[REDACTED]',
    },
    ...(pretty && {
      transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l' } },
    }),
  });
}
