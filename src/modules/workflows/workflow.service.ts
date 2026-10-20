import type { Prisma, Workflow } from '@prisma/client';
import { getNextRunAt, type ScheduleManager } from '../../engine/scheduler.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { buildPage, type Page } from '../../lib/pagination.js';
import { isUniqueConstraintError, toJsonValue } from '../../lib/prisma.js';
import type { WorkflowRepository } from './workflow.repository.js';
import type {
  CreateWorkflowBody,
  ListWorkflowsQuery,
  UpdateWorkflowBody,
} from './workflow.schemas.js';

export interface WorkflowView {
  id: string;
  name: string;
  description: string | null;
  version: number;
  isActive: boolean;
  definition: unknown;
  schedule: { cron: string; timezone: string; nextRunAt: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowService {
  create(body: CreateWorkflowBody): Promise<WorkflowView>;
  get(id: string): Promise<WorkflowView>;
  list(query: ListWorkflowsQuery): Promise<Page<WorkflowView>>;
  update(id: string, body: UpdateWorkflowBody): Promise<WorkflowView>;
  delete(id: string): Promise<void>;
  /** Returns the raw entity; used by the run service. */
  getEntity(id: string): Promise<Workflow>;
}

export function toWorkflowView(workflow: Workflow): WorkflowView {
  const timezone = workflow.cronTimezone ?? 'UTC';
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    version: workflow.version,
    isActive: workflow.isActive,
    definition: workflow.definition,
    schedule: workflow.cronExpression
      ? {
          cron: workflow.cronExpression,
          timezone,
          nextRunAt: workflow.isActive
            ? getNextRunAt(workflow.cronExpression, timezone).toISOString()
            : null,
        }
      : null,
    createdAt: workflow.createdAt.toISOString(),
    updatedAt: workflow.updatedAt.toISOString(),
  };
}

export function createWorkflowService(
  repository: WorkflowRepository,
  schedules: ScheduleManager,
): WorkflowService {
  async function getEntity(id: string): Promise<Workflow> {
    const workflow = await repository.findById(id);
    if (!workflow) throw new NotFoundError('Workflow', id);
    return workflow;
  }

  async function withUniqueName<T>(name: string | undefined, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictError(`A workflow named '${name}' already exists`);
      }
      throw error;
    }
  }

  return {
    getEntity,

    async create(body) {
      const workflow = await withUniqueName(body.name, () =>
        repository.create({
          name: body.name,
          description: body.description ?? null,
          definition: toJsonValue(body.definition),
          isActive: body.isActive,
          cronExpression: body.schedule?.cron ?? null,
          cronTimezone: body.schedule?.timezone ?? null,
        }),
      );
      await schedules.sync(workflow);
      return toWorkflowView(workflow);
    },

    async get(id) {
      return toWorkflowView(await getEntity(id));
    },

    async list(query) {
      const { items, total } = await repository.findMany(query);
      return buildPage(items.map(toWorkflowView), total, query);
    },

    async update(id, body) {
      const existing = await getEntity(id);
      const data: Prisma.WorkflowUpdateInput = {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
        // Runs snapshot the definition, so bumping the version never affects in-flight runs.
        ...(body.definition !== undefined && {
          definition: toJsonValue(body.definition),
          version: existing.version + 1,
        }),
        ...(body.schedule !== undefined && {
          cronExpression: body.schedule?.cron ?? null,
          cronTimezone: body.schedule?.timezone ?? null,
        }),
      };

      const workflow = await withUniqueName(body.name, () => repository.update(id, data));
      await schedules.sync(workflow);
      return toWorkflowView(workflow);
    },

    async delete(id) {
      await getEntity(id);
      await schedules.remove(id);
      await repository.delete(id);
    },
  };
}
