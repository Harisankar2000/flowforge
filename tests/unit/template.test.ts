import { describe, expect, it } from 'vitest';
import { NonRetryableStepError } from '../../src/engine/errors.js';
import { renderTemplate, type TemplateContext } from '../../src/engine/template.js';

const context: TemplateContext = {
  input: { userId: 42, region: 'ap-south-1' },
  run: { id: 'run-1', workflowId: 'wf-1' },
  steps: {
    fetch: { output: { status: 200, body: { items: [{ id: 'a1' }], total: 1 } } },
  },
};

describe('renderTemplate', () => {
  it('interpolates expressions inside strings', () => {
    expect(
      renderTemplate('https://api.test/users/{{input.userId}}?run={{ run.id }}', context),
    ).toBe('https://api.test/users/42?run=run-1');
  });

  it('keeps the original type when the whole string is one expression', () => {
    expect(renderTemplate('{{steps.fetch.output.body}}', context)).toEqual({
      items: [{ id: 'a1' }],
      total: 1,
    });
    expect(renderTemplate('{{input.userId}}', context)).toBe(42);
  });

  it('supports array indexes and nested objects and arrays', () => {
    const rendered = renderTemplate(
      {
        body: { firstId: '{{steps.fetch.output.body.items.0.id}}', tags: ['{{input.region}}', 7] },
      },
      context,
    );

    expect(rendered).toEqual({ body: { firstId: 'a1', tags: ['ap-south-1', 7] } });
  });

  it('serialises objects embedded in text as JSON', () => {
    expect(renderTemplate('items={{steps.fetch.output.body.items}}', context)).toBe(
      'items=[{"id":"a1"}]',
    );
  });

  it('throws a non-retryable error for unknown references', () => {
    expect(() => renderTemplate('{{steps.missing.output}}', context)).toThrow(
      NonRetryableStepError,
    );
  });

  it('cannot reach prototype properties', () => {
    expect(() => renderTemplate('{{input.constructor}}', context)).toThrow(NonRetryableStepError);
    expect(() => renderTemplate('{{input.__proto__}}', context)).toThrow(NonRetryableStepError);
  });

  it('leaves non-template values untouched', () => {
    expect(renderTemplate({ count: 3, enabled: true, empty: null }, context)).toEqual({
      count: 3,
      enabled: true,
      empty: null,
    });
  });
});
