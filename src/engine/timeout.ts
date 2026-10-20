import { StepTimeoutError } from './errors.js';

/**
 * Runs a task with a deadline. The task receives an AbortSignal so I/O
 * (e.g. fetch) is actually cancelled instead of being left running.
 */
export async function runWithTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new StepTimeoutError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([task(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
