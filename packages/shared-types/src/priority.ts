/** Priority of a case or task (domain-model.md: LegalFile.priority, Task.priority). Labels: `enums.priority.<VALUE>`. */
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type Priority = (typeof PRIORITIES)[number];
