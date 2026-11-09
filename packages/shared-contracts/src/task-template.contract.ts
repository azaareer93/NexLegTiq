import { FILE_TYPES } from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { longText, plainText } from './fields.js';

/** Who gets a template's task on a new file (D-156): its responsible lawyer or its paralegal. */
export const TEMPLATE_ASSIGNEE_ROLES = ['RESPONSIBLE_LAWYER', 'PARALEGAL'] as const;

const Fields = z.object({
  name: plainText(200).pipe(z.string().min(1, 'validation.required')),
  /** null = every file type. */
  fileType: z.enum(FILE_TYPES).nullable(),
  defaultTitle: plainText(300).pipe(z.string().min(1, 'validation.required')),
  defaultDescription: longText(5000).nullable(),
  dueDaysAfterOpen: z
    .number()
    .int()
    .min(0, 'validation.dueDays')
    .max(365, 'validation.dueDays')
    .nullable(),
  defaultAssigneeRole: z.enum(TEMPLATE_ASSIGNEE_ROLES),
  isActive: z.boolean(),
});

/** `POST /task-templates` (`manage:office`, D-156). */
export const CreateTaskTemplateSchema = Fields.partial({
  fileType: true,
  defaultDescription: true,
  dueDaysAfterOpen: true,
  isActive: true,
}).extend({ defaultAssigneeRole: z.enum(TEMPLATE_ASSIGNEE_ROLES).default('RESPONSIBLE_LAWYER') });
export type CreateTaskTemplateRequest = z.input<typeof CreateTaskTemplateSchema>;

export const UpdateTaskTemplateSchema = Fields.partial();
export type UpdateTaskTemplateRequest = z.infer<typeof UpdateTaskTemplateSchema>;

export const TaskTemplateSchema = Fields.extend({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TaskTemplate = z.infer<typeof TaskTemplateSchema>;
