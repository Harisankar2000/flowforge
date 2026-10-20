import { CronExpressionParser } from 'cron-parser';
import type { Logger } from '../lib/logger.js';
import { buildSchedulerId, type ScheduleQueue } from './queues.js';

export interface SchedulableWorkflow {
  id: string;
  cronExpression: string | null;
  cronTimezone: string | null;
  isActive: boolean;
}

export interface ScheduleManager {
  sync(workflow: SchedulableWorkflow): Promise<void>;
  remove(workflowId: string): Promise<void>;
  /** Makes Redis match the database. Run on worker start-up. */
  reconcile(workflows: SchedulableWorkflow[]): Promise<void>;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function isValidCron(expression: string, timezone = 'UTC'): boolean {
  // cron-parser accepts unknown timezones silently, so check them separately.
  if (!isValidTimezone(timezone)) return false;
  try {
    CronExpressionParser.parse(expression, { tz: timezone });
    return true;
  } catch {
    return false;
  }
}

export function getNextRunAt(expression: string, timezone = 'UTC', from = new Date()): Date {
  return CronExpressionParser.parse(expression, { tz: timezone, currentDate: from })
    .next()
    .toDate();
}

export function createScheduleManager(queue: ScheduleQueue, logger: Logger): ScheduleManager {
  const manager: ScheduleManager = {
    async sync(workflow) {
      if (!workflow.isActive || !workflow.cronExpression) {
        await manager.remove(workflow.id);
        return;
      }

      // Upsert is idempotent, so every API replica and worker can call it safely.
      await queue.upsertJobScheduler(
        buildSchedulerId(workflow.id),
        { pattern: workflow.cronExpression, tz: workflow.cronTimezone ?? 'UTC' },
        { name: 'trigger-workflow', data: { workflowId: workflow.id } },
      );
      logger.debug({ workflowId: workflow.id, cron: workflow.cronExpression }, 'Schedule synced');
    },

    async remove(workflowId) {
      await queue.removeJobScheduler(buildSchedulerId(workflowId));
    },

    async reconcile(workflows) {
      const desired = new Set(
        workflows.filter((w) => w.isActive && w.cronExpression).map((w) => buildSchedulerId(w.id)),
      );
      const existing = await queue.getJobSchedulers(0, -1);

      for (const scheduler of existing) {
        if (!desired.has(scheduler.key)) await queue.removeJobScheduler(scheduler.key);
      }
      for (const workflow of workflows) await manager.sync(workflow);

      logger.info({ scheduled: desired.size }, 'Schedules reconciled');
    },
  };

  return manager;
}
