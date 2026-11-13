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
import type { Prisma } from '../../generated/prisma/client';
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

/** At most this many notes per file or client in one answer (newest first after the pinned ones). */
const LIMIT = 500;

/** What a note is about: a file (D-154) or a client (D-168). */
export type NoteSubject = { readonly fileId: string } | { readonly clientId: string };

/**
 * Internal notes of a file (MVP-65, D-154) or a client (MVP-55, D-168), encrypted when confidential (D-056). A file's
 * confidential notes are seen only by the office manager and the people assigned to the file (D-051); a client's only by
 * the office manager and their author. Authors change their own notes, OM/SL any they can see.
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

  /** The subject's notes and nothing else: a client's notes are those without a file. */
  private scope(subject: NoteSubject): Prisma.FileNoteWhereInput {
    return 'fileId' in subject
      ? { fileId: subject.fileId }
      : { clientId: subject.clientId, fileId: null };
  }

  /** The subject is there for the caller: a visible file (open to work for a change), or a live client (404). */
  private async assertAccess(subject: NoteSubject, mode: 'read' | 'contribute'): Promise<void> {
    if ('fileId' in subject) {
      await this.access.assertFileAccess(subject.fileId, mode);
      return;
    }
    const live = await this.prisma.db.client.count({
      where: { id: subject.clientId, deletedAt: null },
    });
    if (live === 0) throw new ResourceNotFoundException();
  }

  /** Whether the caller may read the file's confidential notes: the office manager or someone assigned to it. */
  private async seesFileConfidential(fileId: string): Promise<boolean> {
    const { userId, role } = this.caller();
    if (role === 'OFFICE_MANAGER') return true;
    const assigned = await this.prisma.db.legalFile.count({
      where: { AND: [{ id: fileId }, assignedFilesWhere(userId as UserId)] },
    });
    return assigned > 0;
  }

  /** The confidential notes the caller may read: all, none, or (on a client) their own. */
  private async confidentialWhere(subject: NoteSubject): Promise<Prisma.FileNoteWhereInput> {
    const { userId, role } = this.caller();
    if ('fileId' in subject) {
      return (await this.seesFileConfidential(subject.fileId)) ? {} : { isConfidential: false };
    }
    return role === 'OFFICE_MANAGER'
      ? {}
      : { OR: [{ isConfidential: false }, { authorId: userId }] };
  }

  /** Only those who read confidential notes may make one (else the caller would hide it from themselves, D-154). */
  private async mayMakeConfidential(subject: NoteSubject): Promise<boolean> {
    // The author always reads their own confidential client note (D-168).
    return 'fileId' in subject ? this.seesFileConfidential(subject.fileId) : true;
  }

  private async assertMayMakeConfidential(subject: NoteSubject, was: boolean, wanted?: boolean) {
    if (wanted && !was && !(await this.mayMakeConfidential(subject))) {
      throw new PermissionDeniedException();
    }
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

  async list(subject: NoteSubject): Promise<Note[]> {
    await this.assertAccess(subject, 'read');
    const rows = await this.prisma.db.fileNote.findMany({
      where: { ...this.scope(subject), ...(await this.confidentialWhere(subject)) },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: LIMIT,
      select: SELECT,
    });
    return rows.map((row) => this.toNote(row));
  }

  async create(subject: NoteSubject, input: CreateNoteRequest): Promise<Note> {
    const { userId, officeId } = this.caller();
    await this.assertAccess(subject, 'contribute');
    await this.assertMayMakeConfidential(subject, false, input.isConfidential);
    const id = uuidV7();
    const isConfidential = input.isConfidential ?? false;
    const row = await this.uow.run(async (tx) => {
      await this.lock(tx, subject);
      const created = await tx.fileNote.create({
        data: {
          id,
          officeId,
          ...subject,
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
        newValues: { ...subject, authorId: userId, isConfidential, pinned: created.pinned },
      });
      return created;
    });
    return this.toNote(row);
  }

  /** A file's notes change only while the file is live and not archived (re-checked under its lock, D-096). */
  private async lock(tx: ScopedTransaction, subject: NoteSubject): Promise<void> {
    if ('fileId' in subject) await lockFile(tx, this.caller().officeId, subject.fileId);
  }

  /** The note for a change: the subject's, visible to the caller, theirs or the caller is OM/SL. */
  private async changeable(
    tx: ScopedTransaction,
    subject: NoteSubject,
    noteId: string,
  ): Promise<NoteRow> {
    const { userId, role } = this.caller();
    await this.lock(tx, subject);
    const row = await tx.fileNote.findFirst({
      where: { id: noteId, ...this.scope(subject), ...(await this.confidentialWhere(subject)) },
      select: SELECT,
    });
    if (!row) throw new ResourceNotFoundException();
    if (row.authorId !== userId && role !== 'OFFICE_MANAGER' && role !== 'SENIOR_LAWYER') {
      throw new PermissionDeniedException();
    }
    return row;
  }

  async update(subject: NoteSubject, noteId: string, input: UpdateNoteRequest): Promise<Note> {
    if (Object.values(input).every((value) => value === undefined)) {
      throw new ValidationException([{ field: 'body', message: 'validation.required' }]);
    }
    await this.assertAccess(subject, 'contribute');
    return this.uow.run(async (tx) => {
      const before = this.toNote(await this.changeable(tx, subject, noteId));
      await this.assertMayMakeConfidential(subject, before.isConfidential, input.isConfidential);
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
  }

  async remove(subject: NoteSubject, noteId: string): Promise<void> {
    await this.assertAccess(subject, 'contribute');
    await this.uow.run(async (tx) => {
      const row = await this.changeable(tx, subject, noteId);
      await tx.fileNote.delete({ where: { id: noteId } });
      await this.audit.log(tx, {
        entityType: 'FileNote',
        entityId: noteId,
        action: 'DELETE',
        oldValues: { ...subject, isConfidential: row.isConfidential, authorId: row.authorId },
      });
    });
  }
}
