import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { UnauthorizedError } from '../../lib/errors.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Marks a route as reachable without an API key (health checks, metrics). */
    public?: boolean;
  }
}

const PUBLIC_PREFIXES = ['/docs'];

/** Hashing both sides gives equal-length buffers, so the comparison is constant-time. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function isValidApiKey(
  candidate: string | undefined,
  validKeys: readonly Buffer[],
): boolean {
  if (!candidate) return false;
  const hashed = digest(candidate);
  return validKeys.some((key) => timingSafeEqual(hashed, key));
}

/** API-key authentication via the `x-api-key` header. Disabled when no keys are configured. */
export function registerApiKeyAuth(app: FastifyInstance, apiKeys: readonly string[]): void {
  if (apiKeys.length === 0) {
    app.log.warn('API_KEYS is empty: authentication is disabled');
    return;
  }

  const validKeys = apiKeys.map(digest);

  app.addHook('onRequest', async (request) => {
    if (request.routeOptions.config.public) return;
    if (PUBLIC_PREFIXES.some((prefix) => request.url.startsWith(prefix))) return;

    const header = request.headers['x-api-key'];
    if (!isValidApiKey(Array.isArray(header) ? header[0] : header, validKeys)) {
      throw new UnauthorizedError();
    }
  });
}
