import type { StepConfig } from '../definition.js';
import type { StepExecutor } from './types.js';

/**
 * The wait happens in Redis (as a delayed BullMQ job), not in the worker,
 * so a 3-day delay does not hold a worker slot or survive only in memory.
 */
export const delayExecutor: StepExecutor<StepConfig<'delay'>> = {
  getEnqueueDelayMs: (config) => config.durationMs,
  execute: async (config) => ({ delayedMs: config.durationMs }),
};
