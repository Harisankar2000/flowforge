import { describe, expect, it } from 'vitest';
import { findLeafSteps, findReadySteps, validateDag, type DagNode } from '../../src/engine/dag.js';

const node = (key: string, dependsOn: string[] = []): DagNode => ({ key, dependsOn });

describe('validateDag', () => {
  it('returns a topological order that respects dependencies', () => {
    const result = validateDag([
      node('notify', ['transform']),
      node('fetch'),
      node('transform', ['fetch']),
    ]);

    expect(result).toEqual({ ok: true, order: ['fetch', 'transform', 'notify'] });
  });

  it('keeps declaration order for steps that can run in parallel', () => {
    const result = validateDag([node('a'), node('b'), node('c', ['a', 'b'])]);

    expect(result).toEqual({ ok: true, order: ['a', 'b', 'c'] });
  });

  it('rejects duplicate keys, unknown dependencies and self references', () => {
    const result = validateDag([node('a'), node('a'), node('b', ['missing']), node('c', ['c'])]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      "Duplicate step key 'a'",
      "Step 'b' depends on unknown step 'missing'",
      "Step 'c' cannot depend on itself",
    ]);
  });

  it('detects cycles and names the steps involved', () => {
    const result = validateDag([
      node('start'),
      node('a', ['start', 'c']),
      node('b', ['a']),
      node('c', ['b']),
    ]);

    expect(result).toEqual({ ok: false, errors: ['Cycle detected between steps: a, b, c'] });
  });

  it('tolerates the same dependency listed twice', () => {
    expect(validateDag([node('a'), node('b', ['a', 'a'])])).toEqual({
      ok: true,
      order: ['a', 'b'],
    });
  });
});

describe('findReadySteps', () => {
  const nodes = [
    node('fetch'),
    node('enrich', ['fetch']),
    node('audit'),
    node('notify', ['enrich', 'audit']),
  ];

  it('returns pending steps whose dependencies all succeeded', () => {
    const statuses: Record<string, string> = {
      fetch: 'SUCCEEDED',
      enrich: 'PENDING',
      audit: 'RUNNING',
      notify: 'PENDING',
    };

    expect(findReadySteps(nodes, (key) => statuses[key])).toEqual(['enrich']);
  });

  it('does not return steps that are already queued or running', () => {
    const statuses: Record<string, string> = {
      fetch: 'QUEUED',
      enrich: 'PENDING',
      audit: 'RUNNING',
      notify: 'PENDING',
    };

    expect(findReadySteps(nodes, (key) => statuses[key])).toEqual([]);
  });
});

describe('findLeafSteps', () => {
  it('returns steps nothing depends on', () => {
    expect(findLeafSteps([node('a'), node('b', ['a']), node('c', ['a'])])).toEqual(['b', 'c']);
  });
});
