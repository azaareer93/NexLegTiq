import { Injectable } from '@nestjs/common';

import type { IncomingFile } from './multipart';
import { storeUpload } from './store-upload';
import type { StoredUpload } from './store-upload';
import { ValidationException } from '../../../common/errors/app.exception';
import { uuidV7 } from '../../../common/ids/uuid-v7';
import { StorageService } from '../../../common/storage/storage.service';
import { PrismaService } from '../../../database/prisma.service';
import { CaseAccessService } from '../../legal-files/case-access.service';
import { EntitlementsService } from '../../subscriptions/entitlements.service';

const invalid = (field: string, message: string) => new ValidationException([{ field, message }]);

/**
 * Between reading an upload's fields and recording it (D-126): checks that run before a byte is stored, then the
 * storing itself under `{officeId}/{fileId}/{documentId}/{uuid}.{ext}` (D-035) with the plan's storage quota (AUTH-103).
 */
@Injectable()
export class UploadIntake {
  constructor(
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
  async assertTargets(fields: {
    fileId: string;
    folderId?: string | undefined;
    sessionId?: string | undefined;
  }): Promise<void> {
    await this.files.assertFileAccess(fields.fileId, 'contribute');
    if (fields.folderId) {
      const folder = await this.prisma.db.documentFolder.count({
        where: { id: fields.folderId, fileId: fields.fileId },
      });
      if (folder === 0) throw invalid('folderId', 'validation.unknownFolder');
    }
    if (fields.sessionId) {
      const session = await this.prisma.db.session.count({
        where: { id: fields.sessionId, fileId: fields.fileId },
      });
      if (session === 0) throw invalid('sessionId', 'validation.unknownSession');
    }
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
}
