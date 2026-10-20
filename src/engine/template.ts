import { getByPath, isPlainObject } from '../lib/object-path.js';
import { NonRetryableStepError } from './errors.js';

const EXPRESSION_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
const WHOLE_EXPRESSION_PATTERN = /^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/;

export interface TemplateContext {
  input: unknown;
  run: { id: string; workflowId: string };
  steps: Record<string, { output: unknown }>;
}

/**
 * Recursively replaces `{{path}}` expressions in strings, arrays and objects.
 *
 * - A string that is exactly one expression keeps the referenced value's type
 *   (`"{{steps.fetch.output.body}}"` yields an object, not "[object Object]").
 * - Expressions embedded in text are stringified.
 * - Unknown references fail fast: retrying would never fix them.
 */
export function renderTemplate<T>(value: T, context: TemplateContext): T {
  if (typeof value === 'string') return renderString(value, context) as T;
  if (Array.isArray(value)) return value.map((item) => renderTemplate(item, context)) as T;
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, renderTemplate(nested, context)]),
    ) as T;
  }
  return value;
}

function renderString(text: string, context: TemplateContext): unknown {
  const whole = WHOLE_EXPRESSION_PATTERN.exec(text);
  if (whole?.[1]) return resolve(whole[1], context);

  return text.replace(EXPRESSION_PATTERN, (_match, path: string) =>
    stringify(resolve(path, context)),
  );
}

function resolve(path: string, context: TemplateContext): unknown {
  const value = getByPath(context, path);
  if (value === undefined) {
    throw new NonRetryableStepError(`Template reference '{{${path}}}' could not be resolved`);
  }
  return value;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
