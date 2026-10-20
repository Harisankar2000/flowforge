import type { StepConfig } from '../definition.js';
import type { StepExecutor } from './types.js';

export const logExecutor: StepExecutor<StepConfig<'log'>> = {
  async execute(config, { logger, runId, stepKey }) {
    logger[config.level]({ runId, stepKey }, config.message);
    return { message: config.message };
  },
};
