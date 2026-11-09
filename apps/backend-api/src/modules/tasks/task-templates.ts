import type { FileType } from '@nexlegtiq/shared-types';

import { toDbDate } from './tasks.repository';
import type { ScopedTransaction } from '../../database/unit-of-work';

const DAY_MS = 86_400_000;

/** The file a new set of template tasks is for (read from the create transaction, D-156). */
export interface NewFile {
  readonly officeId: string;
  readonly fileId: string;
  readonly fileType: FileType;
  /** The opening date `YYYY-MM-DD` in the office's time zone (D-092). */
  readonly openingDate: string;
  readonly responsibleLawyerId: string;
  readonly responsibleParalegalId: string | null;
  readonly createdById: string;
}

/**
 * On file create (MVP-78, D-156): every active template of the office for the file's type (or for every type) becomes a
 * TODO task in the same transaction — due `dueDaysAfterOpen` days after the opening date, assigned to the file's
 * responsible lawyer or paralegal (skipped when the file has no paralegal), placed at the end of the TODO column.
 */
export async function applyTaskTemplates(
  tx: Pick<ScopedTransaction, 'taskTemplate' | 'task'>,
  file: NewFile,
): Promise<number> {
  const templates = await tx.taskTemplate.findMany({
    where: { isActive: true, OR: [{ fileType: null }, { fileType: file.fileType }] },
    orderBy: [{ dueDaysAfterOpen: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
  });
  if (templates.length === 0) return 0;
  const { _max } = await tx.task.aggregate({
    where: { status: 'TODO' },
    _max: { sortOrder: true },
  });
  let position = (_max.sortOrder ?? -1) + 1;
  const opened = Date.parse(`${file.openingDate}T00:00:00Z`);
  const rows = templates.flatMap((template) => {
    const assignedToId =
      template.defaultAssigneeRole === 'PARALEGAL'
        ? file.responsibleParalegalId
        : file.responsibleLawyerId;
    if (!assignedToId) return [];
    return [
      {
        officeId: file.officeId,
        fileId: file.fileId,
        title: template.defaultTitle,
        description: template.defaultDescription,
        dueDate:
          template.dueDaysAfterOpen === null
            ? null
            : toDbDate(
                new Date(opened + template.dueDaysAfterOpen * DAY_MS).toISOString().slice(0, 10),
              ),
        assignedToId,
        createdById: file.createdById,
        sortOrder: position++,
        sourceType: 'TEMPLATE' as const,
        sourceId: template.id,
      },
    ];
  });
  if (rows.length > 0) await tx.task.createMany({ data: rows });
  return rows.length;
}

interface Starter {
  readonly fileType: FileType;
  readonly days: number;
  readonly role: 'RESPONSIBLE_LAWYER' | 'PARALEGAL';
  readonly ar: { readonly name: string; readonly title: string };
  readonly en: { readonly name: string; readonly title: string };
}

/** Starter templates every new office gets, in its own language (the ticket's litigation and lease examples). */
const STARTERS: readonly Starter[] = [
  {
    fileType: 'LITIGATION',
    days: 7,
    role: 'RESPONSIBLE_LAWYER',
    ar: { name: 'دعوى: لائحة الدعوى', title: 'إعداد لائحة الدعوى' },
    en: { name: 'Litigation: statement of claim', title: 'Prepare the statement of claim' },
  },
  {
    fileType: 'LITIGATION',
    days: 14,
    role: 'PARALEGAL',
    ar: { name: 'دعوى: البيّنات', title: 'تقديم البيّنات' },
    en: { name: 'Litigation: evidence', title: 'File the evidence' },
  },
  {
    fileType: 'LITIGATION',
    days: 30,
    role: 'RESPONSIBLE_LAWYER',
    ar: { name: 'دعوى: التبليغ', title: 'تبليغ المدعى عليه' },
    en: { name: 'Litigation: service', title: 'Serve the defendant' },
  },
  {
    fileType: 'RENTAL_AGREEMENT',
    days: 3,
    role: 'RESPONSIBLE_LAWYER',
    ar: { name: 'عقد إيجار: الصياغة', title: 'صياغة عقد الإيجار' },
    en: { name: 'Lease: drafting', title: 'Draft the lease' },
  },
  {
    fileType: 'RENTAL_AGREEMENT',
    days: 14,
    role: 'PARALEGAL',
    ar: { name: 'عقد إيجار: التوثيق', title: 'توثيق عقد الإيجار وتسجيله' },
    en: { name: 'Lease: registration', title: 'Register the signed lease' },
  },
];

/** The starter templates as rows for a new office (signup, D-083), in the office's default language. */
export function starterTemplates(officeId: string, language: string) {
  return STARTERS.map((starter) => {
    const text = language === 'EN' ? starter.en : starter.ar;
    return {
      officeId,
      name: text.name,
      fileType: starter.fileType,
      defaultTitle: text.title,
      dueDaysAfterOpen: starter.days,
      defaultAssigneeRole: starter.role,
    };
  });
}
