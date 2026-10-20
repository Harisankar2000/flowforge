const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Reads a nested value using dot notation (`a.b.0.c`).
 * Only own properties are traversed, so prototype pollution paths resolve to `undefined`.
 */
export function getByPath(source: unknown, path: string): unknown {
  let current: unknown = source;

  for (const segment of path.split('.')) {
    if (FORBIDDEN_SEGMENTS.has(segment)) return undefined;
    if (current === null || typeof current !== 'object') return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
