import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import type { IncomingFile } from './multipart';
import { storeUpload } from './store-upload';
import type { StoredUpload } from './store-upload';
import type { RequestContext } from '../../../common/context/request-context';
import {
  BusinessRuleException,
  ResourceNotFoundException,
  ValidationException,
} from '../../../common/errors/app.exception';
import { uuidV7 } from '../../../common/ids/uuid-v7';
import { StorageService } from '../../../common/storage/storage.service';
import { PrismaService } from '../../../database/prisma.service';
import type { ScopedTransaction } from '../../../database/unit-of-work';
import { CaseAccessService } from '../../legal-files/case-access.service';
import { EntitlementsService } from '../../subscriptions/entitlements.service';

const invalid = (field: string, message: string) => new ValidationException([{ field, message }]);

export interface UploadTargets {
  readonly fileId: string;
  readonly folderId?: string | undefined;
  readonly sessionId?: string | undefined;
}

/**
 * Between reading an upload's fields and recording it (D-126): checks that run before a byte is stored, the storing itself
 * under `{officeId}/{fileId}/{documentId}/{uuid}.{ext}` (D-035) with the plan's storage quota (AUTH-103), and the same
 * checks again under a lock once the (possibly long) upload is done.
 */
@Injectable()
export class UploadIntake {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly prisma: PrismaService,
    private readonly files: CaseAccessService,
    private readonly entitlements: EntitlementsService,
    private readonly storage: StorageService,
  ) {}

  /** Runs `checks`, then refuses a full quota at once; a refusal drains the file so the client hears the answer. */
  async beforeStoring<T>(file: IncomingFile, checks: () => Promise<T>): Promise<T> {
    try {
      const result = await checks();
      // The exact size is checked once it is known (`store`).
      await this.entitlements.assertStorageFor(1n);
      return result;
    } catch (error) {
      file.stream.resume();
      throw error;
    }
  }

  /** The file can take documents (visible, not archived), and the folder and hearing are the file's own. */
  async assertTargets(targets: UploadTargets): Promise<void> {
    await this.files.assertFileAccess(targets.fileId, 'contribute');
    await this.assertPlacement(this.prisma.db, targets);
  }

  /**
   * Inside the write: locks the file row (as folder writes do, D-119) and checks again that it is live (404) and not
   * archived (BIZ-007), and that the folder and hearing still belong to it — the upload may have taken minutes.
   */
  async recheck(tx: ScopedTransaction, targets: UploadTargets): Promise<void> {
    const [file] = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM legal_files
      WHERE id = ${targets.fileId}::uuid AND office_id = ${this.officeId()}::uuid AND deleted_at IS NULL
      FOR NO KEY UPDATE`;
    if (!file) throw new ResourceNotFoundException();
    if (file.status === 'ARCHIVED') {
      throw new BusinessRuleException('BIZ-007', 'The file is archived and read-only');
    }
    await this.assertPlacement(tx, targets);
  }

  /** Streams the file to storage; deleted again when it does not fit the quota. */
  async store(file: IncomingFile, fileId: string, documentId: string): Promise<StoredUpload> {
    const stored = await storeUpload(this.storage, file, (ext) =>
      this.storage.keyFor(fileId, documentId, `${uuidV7()}.${ext}`),
    );
    try {
      await this.entitlements.assertStorageFor(BigInt(stored.sizeBytes));
    } catch (error) {
      await this.discard(stored.key);
      throw error;
    }
    return stored;
  }

  /** Best effort: an object whose record could not be written is removed (a leftover only costs storage). */
  async discard(key: string): Promise<void> {
    await this.storage.delete(key).catch(() => undefined);
  }

  private async assertPlacement(
    db: Pick<ScopedTransaction, 'documentFolder' | 'session'>,
    { fileId, folderId, sessionId }: UploadTargets,
  ): Promise<void> {
    if (folderId && (await db.documentFolder.count({ where: { id: folderId, fileId } })) === 0) {
      throw invalid('folderId', 'validation.unknownFolder');
    }
    if (sessionId && (await db.session.count({ where: { id: sessionId, fileId } })) === 0) {
      throw invalid('sessionId', 'validation.unknownSession');
    }
  }

  private officeId(): string {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the request context');
    return officeId;
  }
}
