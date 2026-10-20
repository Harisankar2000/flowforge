import { describe, expect, it, vi } from 'vitest';
import { NonRetryableStepError } from '../../src/engine/errors.js';
import {
  createHttpExecutor,
  isHostAllowed,
  isRetryableStatus,
} from '../../src/engine/executors/http.executor.js';
import type { StepExecutionContext } from '../../src/engine/executors/types.js';
import type { Logger } from '../../src/lib/logger.js';

const context: StepExecutionContext = {
  runId: 'run-1',
  stepKey: 'call',
  attempt: 1,
  signal: new AbortController().signal,
  logger: {} as Logger,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('http executor', () => {
  it('sends a JSON body and returns status, headers and parsed body', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(201, { id: 'x1' }));
    const executor = createHttpExecutor({ allowedHosts: [], fetchImpl });

    const output = await executor.execute(
      {
        method: 'POST',
        url: 'https://api.test/items',
        headers: { 'x-trace': 't1' },
        body: { a: 1 },
      },
      context,
    );

    expect(output).toMatchObject({ status: 201, body: { id: 'x1' } });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://api.test/items');
    expect(init).toMatchObject({
      method: 'POST',
      body: '{"a":1}',
      headers: { 'content-type': 'application/json', 'x-trace': 't1' },
    });
  });

  it('throws a retryable error for 5xx responses', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(503, {}));
    const executor = createHttpExecutor({ allowedHosts: [], fetchImpl });

    const promise = executor.execute(
      { method: 'GET', url: 'https://api.test', headers: {} },
      context,
    );

    await expect(promise).rejects.toThrow('HTTP 503');
    await expect(promise).rejects.not.toBeInstanceOf(NonRetryableStepError);
  });

  it('throws a non-retryable error for 4xx responses', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(404, {}));
    const executor = createHttpExecutor({ allowedHosts: [], fetchImpl });

    await expect(
      executor.execute({ method: 'GET', url: 'https://api.test/missing', headers: {} }, context),
    ).rejects.toBeInstanceOf(NonRetryableStepError);
  });

  it('accepts custom expected status codes', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(404, { found: false }));
    const executor = createHttpExecutor({ allowedHosts: [], fetchImpl });

    const output = await executor.execute(
      { method: 'GET', url: 'https://api.test', headers: {}, expectStatus: [200, 404] },
      context,
    );

    expect(output).toMatchObject({ status: 404 });
  });

  it('rejects invalid URLs, other protocols and hosts outside the allowlist', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const executor = createHttpExecutor({ allowedHosts: ['api.test'], fetchImpl });
    const run = (url: string) => executor.execute({ method: 'GET', url, headers: {} }, context);

    await expect(run('not a url')).rejects.toBeInstanceOf(NonRetryableStepError);
    await expect(run('file:///etc/passwd')).rejects.toBeInstanceOf(NonRetryableStepError);
    await expect(run('http://169.254.169.254/latest')).rejects.toThrow(
      'not in HTTP_STEP_ALLOWED_HOSTS',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('isHostAllowed', () => {
  it('allows everything when the list is empty', () => {
    expect(isHostAllowed('anything.example', [])).toBe(true);
  });

  it('matches exact hosts and wildcard subdomains case-insensitively', () => {
    const allowed = ['api.test', '*.internal.test'];
    expect(isHostAllowed('API.test', allowed)).toBe(true);
    expect(isHostAllowed('billing.internal.test', allowed)).toBe(true);
    expect(isHostAllowed('internal.test', allowed)).toBe(false);
    expect(isHostAllowed('evil-api.test', allowed)).toBe(false);
  });
});

describe('isRetryableStatus', () => {
  it.each([408, 425, 429, 500, 502, 503])('treats %i as retryable', (status) => {
    expect(isRetryableStatus(status)).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])('treats %i as permanent', (status) => {
    expect(isRetryableStatus(status)).toBe(false);
  });
});
