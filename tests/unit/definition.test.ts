import { describe, expect, it } from 'vitest';
import { workflowDefinitionSchema } from '../../src/engine/definition.js';

describe('workflowDefinitionSchema', () => {
  it('applies defaults for retry, timeout and dependencies', () => {
    const definition = workflowDefinitionSchema.parse({
      steps: [{ key: 'ping', type: 'http', config: { url: 'https://api.test' } }],
    });

    expect(definition.steps[0]).toEqual({
      key: 'ping',
      type: 'http',
      dependsOn: [],
      timeoutMs: 30_000,
      retry: { maxAttempts: 3, backoff: 'exponential', delayMs: 1_000 },
      config: { method: 'GET', url: 'https://api.test', headers: {} },
    });
  });

  it('rejects definitions with a cycle', () => {
    const result = workflowDefinitionSchema.safeParse({
      steps: [
        { key: 'a', type: 'log', dependsOn: ['b'], config: { message: 'a' } },
        { key: 'b', type: 'log', dependsOn: ['a'], config: { message: 'b' } },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Cycle detected between steps: a, b');
  });

  it('rejects unknown step types and invalid step keys', () => {
    expect(
      workflowDefinitionSchema.safeParse({ steps: [{ key: 'a', type: 'shell', config: {} }] })
        .success,
    ).toBe(false);
    expect(
      workflowDefinitionSchema.safeParse({
        steps: [{ key: '1-bad key', type: 'log', config: { message: 'x' } }],
      }).success,
    ).toBe(false);
  });

  it('caps retries to protect downstream services', () => {
    const result = workflowDefinitionSchema.safeParse({
      steps: [{ key: 'a', type: 'log', retry: { maxAttempts: 50 }, config: { message: 'x' } }],
    });

    expect(result.success).toBe(false);
  });
});
