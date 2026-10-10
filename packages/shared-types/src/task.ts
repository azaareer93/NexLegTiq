/** Task status = its Kanban column (domain-model.md#tasks). Mirrors the Prisma enum; labels: `enums.taskStatus.<VALUE>`. */
export const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
