import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

export const runsTriggeredTotal = new Counter({
  name: 'flowforge_runs_triggered_total',
  help: 'Workflow runs created, by trigger type',
  labelNames: ['trigger'] as const,
  registers: [metricsRegistry],
});

export const runsFinishedTotal = new Counter({
  name: 'flowforge_runs_finished_total',
  help: 'Workflow runs that reached a terminal state, by status',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

export const stepAttemptsTotal = new Counter({
  name: 'flowforge_step_attempts_total',
  help: 'Step execution attempts, by step type and outcome (succeeded, retrying, failed)',
  labelNames: ['type', 'outcome'] as const,
  registers: [metricsRegistry],
});

export const stepDurationSeconds = new Histogram({
  name: 'flowforge_step_duration_seconds',
  help: 'Duration of a single step attempt',
  labelNames: ['type'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [metricsRegistry],
});
