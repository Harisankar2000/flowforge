import type { Logger } from '../../lib/logger.js';
import type { StepConfig, StepType } from '../definition.js';

export interface StepExecutionContext {
  runId: string;
  stepKey: string;
  attempt: number;
  signal: AbortSignal;
  logger: Logger;
}

/**
 * Contract every step type implements. Adding a new step type means adding a
 * schema in definition.ts and an executor here; the engine itself is unchanged.
 */
export interface StepExecutor<TConfig> {
  execute(config: TConfig, context: StepExecutionContext): Promise<unknown>;
  /** Optional delay applied when the step is enqueued (used by the delay step). */
  getEnqueueDelayMs?(config: TConfig): number;
}

export type ExecutorRegistry = { [K in StepType]: StepExecutor<StepConfig<K>> };
