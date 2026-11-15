import type { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';

type Db = PrismaService['db'];

/**
 * Finding a file's audit rows (D-180): its own ids and those of its tasks, documents, hearings, notes, time entries and
 * witnesses (views, downloads and edits that do not repeat the file id), and rows whose values name the file.
 * shortcut: child ids are read per request and JSON values scanned without an index; a `file_id` column on the audit
 * log when a file's history grows slow.
 */
/** The files and their tasks, documents, hearings, notes, time entries and witnesses: the ids their audit rows carry. */
export async function fileEntityIds(db: Db, fileIds: readonly string[]): Promise<string[]> {
  const where = { fileId: { in: [...fileIds] } };
  const select = { id: true } as const;
  const children = await Promise.all([
    db.task.findMany({ where, select }),
    db.document.findMany({ where, select }),
    db.session.findMany({ where, select }),
    db.fileNote.findMany({ where, select }),
    db.timeEntry.findMany({ where, select }),
    db.witness.findMany({ where, select }),
  ]);
  return [...fileIds, ...children.flat().map((row) => row.id)];
}

/** A file's rows: those of its own ids, or whose values name it (`fileId`). */
export async function fileRowsWhere(db: Db, fileId: string): Promise<Prisma.AuditLogWhereInput> {
  return {
    OR: [
      { entityId: { in: await fileEntityIds(db, [fileId]) } },
      { newValues: { path: ['fileId'], equals: fileId } },
      { oldValues: { path: ['fileId'], equals: fileId } },
    ],
  };
}
