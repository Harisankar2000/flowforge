import type { StepDefinition } from '../definition.js';
import { delayExecutor } from './delay.executor.js';
import { createHttpExecutor, type HttpExecutorOptions } from './http.executor.js';
import { logExecutor } from './log.executor.js';
import type { ExecutorRegistry, StepExecutionContext, StepExecutor } from './types.js';

export interface ExecutorRegistryOptions {
  http: HttpExecutorOptions;
}

export function createExecutorRegistry(options: ExecutorRegistryOptions): ExecutorRegistry {
  return {
    http: createHttpExecutor(options.http),
    delay: delayExecutor,
    log: logExecutor,
  };
}

/**
 * The registry is keyed by step type, so the executor always matches the
 * config shape. TypeScript cannot correlate the union on its own, hence the
 * single narrow cast kept in this one place.
 */
function executorFor(registry: ExecutorRegistry, step: StepDefinition): StepExecutor<unknown> {
  return registry[step.type] as StepExecutor<unknown>;
}

export function executeStep(
  registry: ExecutorRegistry,
  step: StepDefinition,
  resolvedConfig: StepDefinition['config'],
  context: StepExecutionContext,
): Promise<unknown> {
  return executorFor(registry, step).execute(resolvedConfig, context);
}

export function getEnqueueDelayMs(registry: ExecutorRegistry, step: StepDefinition): number {
  return executorFor(registry, step).getEnqueueDelayMs?.(step.config) ?? 0;
}
