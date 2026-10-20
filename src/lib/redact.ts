import { isPlainObject } from './object-path.js';

const SENSITIVE_KEY_PATTERN = /(authorization|api[-_]?key|password|secret|token|cookie)/i;
const REDACTED = '[REDACTED]';

/**
 * Returns a deep copy with values of sensitive-looking keys masked.
 * Used before persisting resolved step inputs, which may contain credentials.
 */
export function redactSensitive<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item)) as T;
  if (!isPlainObject(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactSensitive(nested),
    ]),
  ) as T;
}
