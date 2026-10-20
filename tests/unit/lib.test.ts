import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { StepTimeoutError } from '../../src/engine/errors.js';
import { getNextRunAt, isValidCron } from '../../src/engine/scheduler.js';
import { runWithTimeout } from '../../src/engine/timeout.js';
import { isValidApiKey } from '../../src/http/plugins/auth.js';
import { getErrorMessage } from '../../src/lib/errors.js';
import { getByPath } from '../../src/lib/object-path.js';
import { buildPage, toSkipTake } from '../../src/lib/pagination.js';
import { redactSensitive } from '../../src/lib/redact.js';

describe('getByPath', () => {
  const source = { a: { b: [{ c: 1 }] }, zero: 0 };

  it('reads nested values and array items', () => {
    expect(getByPath(source, 'a.b.0.c')).toBe(1);
    expect(getByPath(source, 'zero')).toBe(0);
  });

  it('returns undefined for missing or inherited properties', () => {
    expect(getByPath(source, 'a.x.y')).toBeUndefined();
    expect(getByPath(source, 'toString')).toBeUndefined();
    expect(getByPath(source, '__proto__')).toBeUndefined();
  });
});

describe('redactSensitive', () => {
  it('masks credentials at any depth without mutating the input', () => {
    const input = {
      headers: { Authorization: 'Bearer x', 'x-api-key': 'k' },
      body: { password: 'p', name: 'n' },
    };

    expect(redactSensitive(input)).toEqual({
      headers: { Authorization: '[REDACTED]', 'x-api-key': '[REDACTED]' },
      body: { password: '[REDACTED]', name: 'n' },
    });
    expect(input.headers.Authorization).toBe('Bearer x');
  });
});

describe('pagination', () => {
  it('converts page numbers to skip/take and builds page metadata', () => {
    expect(toSkipTake({ page: 3, pageSize: 20 })).toEqual({ skip: 40, take: 20 });
    expect(buildPage(['a'], 41, { page: 3, pageSize: 20 })).toEqual({
      items: ['a'],
      page: 3,
      pageSize: 20,
      total: 41,
      totalPages: 3,
    });
  });
});

describe('runWithTimeout', () => {
  it('resolves when the task finishes in time', async () => {
    await expect(runWithTimeout(async () => 'done', 100)).resolves.toBe('done');
  });

  it('rejects with StepTimeoutError and aborts the task signal', async () => {
    let signal: AbortSignal | undefined;
    const task = (taskSignal: AbortSignal) => {
      signal = taskSignal;
      return new Promise<never>(() => undefined);
    };

    await expect(runWithTimeout(task, 20)).rejects.toBeInstanceOf(StepTimeoutError);
    expect(signal?.aborted).toBe(true);
  });
});

describe('cron helpers', () => {
  it('validates expressions and timezones', () => {
    expect(isValidCron('*/5 * * * *')).toBe(true);
    expect(isValidCron('0 9 * * MON-FRI', 'Asia/Kolkata')).toBe(true);
    expect(isValidCron('not a cron')).toBe(false);
    expect(isValidCron('0 9 * * *', 'Mars/Olympus')).toBe(false);
  });

  it('computes the next run in the given timezone', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    expect(getNextRunAt('30 9 * * *', 'Asia/Kolkata', from).toISOString()).toBe(
      '2026-01-01T04:00:00.000Z',
    );
  });
});

describe('isValidApiKey', () => {
  const keys = ['secret-1', 'secret-2'].map((key) => createHash('sha256').update(key).digest());

  it('accepts configured keys only', () => {
    expect(isValidApiKey('secret-2', keys)).toBe(true);
    expect(isValidApiKey('secret-3', keys)).toBe(false);
    expect(isValidApiKey(undefined, keys)).toBe(false);
  });
});

describe('getErrorMessage', () => {
  it('includes nested causes and handles non-Error values', () => {
    const error = new Error('fetch failed', { cause: new Error('ECONNREFUSED') });

    expect(getErrorMessage(error)).toBe('fetch failed: ECONNREFUSED');
    expect(getErrorMessage('plain')).toBe('plain');
    expect(getErrorMessage({ code: 1 })).toBe('{"code":1}');
  });
});
