import { Injectable } from '@nestjs/common';
import type { CreateNoteRequest, Note, UpdateNoteRequest } from '@nexlegtiq/shared-contracts';
import type { UserId } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';

import { AuditService } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import { FieldCipher } from '../../common/crypto/field-cipher';
import {
  PermissionDeniedException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import { uuidV7 } from '../../common/ids/uuid-v7';
import { assignedFilesWhere } from '../../common/rbac/case-scope';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { ScopedTransaction } from '../../database/unit-of-work';
import { lockFile } from '../file-participants/file-lock';
import { CaseAccessService } from '../legal-files/case-access.service';

const SELECT = {
  id: true,
  body: true,
  isConfidential: true,
  pinned: true,
  authorId: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, fullName: true } },
} as const;
type NoteRow = {
  id: string;
  body: string;
  isConfidential: boolean;
  pinned: boolean;
  authorId: string;
  createdAt: Date;
  updatedAt: Date;
  author: { id: string; fullName: string };
};

/** At most this many notes per file in one answer (newest first after the pinned ones). */
const LIMIT = 500;

/**
 * A file's notes (MVP-65, D-154). Confidential notes are encrypted (D-056) and seen only by the office manager and the
 * people assigned to the file (D-051); authors change their own notes, OM/SL any they can see.
 */
@Injectable()
export class NotesService {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly access: CaseAccessService,
    private readonly cipher: FieldCipher,
    private readonly audit: AuditService,
  ) {}

  private caller() {
    const userId = this.cls.get('userId');
    const role = this.cls.get('role');
    const officeId = this.cls.get('officeId');
    if (!userId || !role || !officeId) throw new Error('No office caller in the request context');
    return { userId, role, officeId };
  }

  private context(noteId: string): string {
    return `file_notes.body:${this.caller().officeId}:${noteId}`;
  }

  /** Whether the caller may read the file's confidential notes: the office manager or someone assigned to it. */
  private async seesConfidential(fileId: string): Promise<boolean> {
    const { userId, role } = this.caller();
    if (role === 'OFFICE_MANAGER') return true;
    const assigned = await this.prisma.db.legalFile.count({
      where: { AND: [{ id: fileId }, assignedFilesWhere(userId as UserId)] },
    });
    return assigned > 0;
  }

  private toNote(row: NoteRow): Note {
    const { userId, role } = this.caller();
    return {
      id: row.id,
      body: row.isConfidential ? this.cipher.decrypt(row.body, this.context(row.id)) : row.body,
      isConfidential: row.isConfidential,
      pinned: row.pinned,
      author: row.author,
      canEdit: row.authorId === userId || role === 'OFFICE_MANAGER' || role === 'SENIOR_LAWYER',
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async list(fileId: string): Promise<Note[]> {
    await this.access.assertFileAccess(fileId, 'read');
    const confidential = await this.seesConfidential(fileId);
    const rows = await this.prisma.db.fileNote.findMany({
      where: { fileId, ...(confidential ? {} : { isConfidential: false }) },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: LIMIT,
      select: SELECT,
    });
    return rows.map((row) => this.toNote(row));
  }

  async create(fileId: string, input: CreateNoteRequest): Promise<Note> {
    const { userId, officeId } = this.caller();
    await this.access.assertFileAccess(fileId, 'contribute');
    if (input.isConfidential && !(await this.seesConfidential(fileId))) {
      throw new PermissionDeniedException();
    }
    const id = uuidV7();
    const isConfidential = input.isConfidential ?? false;
    const row = await this.uow.run(async (tx) => {
      await lockFile(tx, officeId, fileId);
      const created = await tx.fileNote.create({
        data: {
          id,
          officeId,
          fileId,
          authorId: userId,
          body: isConfidential ? this.cipher.encrypt(input.body, this.context(id)) : input.body,
          isConfidential,
          pinned: input.pinned ?? false,
        },
        select: SELECT,
      });
      await this.audit.log(tx, {
        entityType: 'FileNote',
        entityId: id,
        action: 'CREATE',
        // The text is never audited: it may be confidential, and the note itself is the record.
        newValues: { fileId, authorId: userId, isConfidential, pinned: created.pinned },
      });
      return created;
    });
    return this.toNote(row);
  }

  /** The note for a change: on the file, visible to the caller, theirs or the caller is OM/SL; the file open to work. */
  private async changeable(
    tx: ScopedTransaction,
    fileId: string,
    noteId: string,
  ): Promise<NoteRow> {
    const { userId, role, officeId } = this.caller();
    await lockFile(tx, officeId, fileId);
    const confidential = await this.seesConfidential(fileId);
    const row = await tx.fileNote.findFirst({
      where: { id: noteId, fileId, ...(confidential ? {} : { isConfidential: false }) },
      select: SELECT,
    });
    if (!row) throw new ResourceNotFoundException();
    if (row.authorId !== userId && role !== 'OFFICE_MANAGER' && role !== 'SENIOR_LAWYER') {
      throw new PermissionDeniedException();
    }
    return row;
  }

  /** Only those who read confidential notes may make one (else the caller would hide it from themselves, D-154). */
  private async assertMayMakeConfidential(fileId: string, was: boolean, wanted?: boolean) {
    if (wanted && !was && !(await this.seesConfidential(fileId)))
      throw new PermissionDeniedException();
  }

  async update(fileId: string, noteId: string, input: UpdateNoteRequest): Promise<Note> {
    if (Object.values(input).every((value) => value === undefined)) {
      throw new ValidationException([{ field: 'body', message: 'validation.required' }]);
    }
    await this.access.assertFileAccess(fileId, 'contribute');
    const row = await this.uow.run(async (tx) => {
      const before = this.toNote(await this.changeable(tx, fileId, noteId));
      await this.assertMayMakeConfidential(fileId, before.isConfidential, input.isConfidential);
      const isConfidential = input.isConfidential ?? before.isConfidential;
      const body = input.body ?? before.body;
      const pinned = input.pinned ?? before.pinned;
      // A change that changes nothing writes nothing (D-096, D-125).
      const bodyChanged = body !== before.body;
      if (!bodyChanged && isConfidential === before.isConfidential && pinned === before.pinned) {
        return before;
      }
      const updated = await tx.fileNote.update({
        where: { id: noteId },
        data: {
          body: isConfidential ? this.cipher.encrypt(body, this.context(noteId)) : body,
          isConfidential,
          pinned,
        },
        select: SELECT,
      });
      await this.audit.log(tx, {
        entityType: 'FileNote',
        entityId: noteId,
        action: 'UPDATE',
        oldValues: { isConfidential: before.isConfidential, pinned: before.pinned },
        newValues: {
          isConfidential,
          pinned: updated.pinned,
          ...(bodyChanged ? { bodyChanged: true } : {}),
        },
      });
      return this.toNote(updated);
    });
    return row;
  }

  async remove(fileId: string, noteId: string): Promise<void> {
    await this.access.assertFileAccess(fileId, 'contribute');
    await this.uow.run(async (tx) => {
      const row = await this.changeable(tx, fileId, noteId);
      await tx.fileNote.delete({ where: { id: noteId } });
      await this.audit.log(tx, {
        entityType: 'FileNote',
        entityId: noteId,
        action: 'DELETE',
        oldValues: { fileId, isConfidential: row.isConfidential, authorId: row.authorId },
      });
    });
  }
}
