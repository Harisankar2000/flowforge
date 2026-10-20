import type { Prisma, PrismaClient, Workflow } from '@prisma/client';
import { toSkipTake } from '../../lib/pagination.js';
import type { ListWorkflowsQuery } from './workflow.schemas.js';

export interface WorkflowRepository {
  create(data: Prisma.WorkflowCreateInput): Promise<Workflow>;
  findById(id: string): Promise<Workflow | null>;
  findMany(query: ListWorkflowsQuery): Promise<{ items: Workflow[]; total: number }>;
  findAll(): Promise<Workflow[]>;
  update(id: string, data: Prisma.WorkflowUpdateInput): Promise<Workflow>;
  delete(id: string): Promise<void>;
}

export function createWorkflowRepository(prisma: PrismaClient): WorkflowRepository {
  return {
    create: (data) => prisma.workflow.create({ data }),

    findById: (id) => prisma.workflow.findUnique({ where: { id } }),

    async findMany(query) {
      const where: Prisma.WorkflowWhereInput = {
        ...(query.isActive !== undefined && { isActive: query.isActive }),
        ...(query.search && { name: { contains: query.search, mode: 'insensitive' } }),
      };
      const [items, total] = await prisma.$transaction([
        prisma.workflow.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(query) }),
        prisma.workflow.count({ where }),
      ]);
      return { items, total };
    },

    findAll: () => prisma.workflow.findMany(),

    update: (id, data) => prisma.workflow.update({ where: { id }, data }),

    async delete(id) {
      await prisma.workflow.delete({ where: { id } });
    },
  };
}
