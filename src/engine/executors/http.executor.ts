import type { StepConfig } from '../definition.js';
import { NonRetryableStepError } from '../errors.js';
import type { StepExecutor } from './types.js';

/** Status codes where a later attempt can reasonably succeed. */
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429]);
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;

export interface HttpExecutorOptions {
  /** Exact hosts or wildcard suffixes (`*.example.com`). Empty means any host. */
  allowedHosts: readonly string[];
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}

export interface HttpStepOutput {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export function createHttpExecutor(options: HttpExecutorOptions): StepExecutor<StepConfig<'http'>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return {
    async execute(config, { signal }): Promise<HttpStepOutput> {
      const url = parseUrl(config.url);
      assertHostAllowed(url.hostname, options.allowedHosts);

      const hasBody = config.body !== undefined && config.method !== 'GET';
      const response = await fetchImpl(url, {
        method: config.method,
        headers: {
          ...(hasBody && { 'content-type': 'application/json' }),
          ...config.headers,
        },
        body: hasBody ? JSON.stringify(config.body) : undefined,
        redirect: 'manual',
        signal,
      });

      const output: HttpStepOutput = {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await readBody(response, maxResponseBytes),
      };

      const isExpected = config.expectStatus
        ? config.expectStatus.includes(response.status)
        : response.ok;

      if (!isExpected) {
        const message = `HTTP ${response.status} from ${config.method} ${url.origin}${url.pathname}`;
        if (isRetryableStatus(response.status)) throw new Error(message);
        throw new NonRetryableStepError(message);
      }

      return output;
    },
  };
}

export function isRetryableStatus(status: number): boolean {
  return status >= 500 || RETRYABLE_STATUS_CODES.has(status);
}

export function isHostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  if (allowedHosts.length === 0) return true;
  const host = hostname.toLowerCase();
  return allowedHosts.some((pattern) => {
    const rule = pattern.toLowerCase();
    return rule.startsWith('*.') ? host.endsWith(rule.slice(1)) : host === rule;
  });
}

function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NonRetryableStepError(`Invalid URL '${raw}'`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NonRetryableStepError(`Unsupported protocol '${url.protocol}'`);
  }
  return url;
}

function assertHostAllowed(hostname: string, allowedHosts: readonly string[]): void {
  if (!isHostAllowed(hostname, allowedHosts)) {
    throw new NonRetryableStepError(`Host '${hostname}' is not in HTTP_STEP_ALLOWED_HOSTS`);
  }
}

async function readBody(response: Response, maxBytes: number): Promise<unknown> {
  const text = await response.text();
  const truncated = text.length > maxBytes ? text.slice(0, maxBytes) : text;
  if (truncated.length === 0) return null;

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json') && truncated.length === text.length) {
    try {
      return JSON.parse(truncated);
    } catch {
      return truncated;
    }
  }
  return truncated;
}
