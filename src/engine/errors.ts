/**
 * Thrown when retrying cannot help (bad config, 4xx response, unresolved template).
 * The step fails immediately instead of consuming its remaining attempts.
 */
export class NonRetryableStepError extends Error {
  override readonly name = 'NonRetryableStepError';
}

export class StepTimeoutError extends Error {
  override readonly name = 'StepTimeoutError';

  constructor(readonly timeoutMs: number) {
    super(`Step timed out after ${timeoutMs}ms`);
  }
}
