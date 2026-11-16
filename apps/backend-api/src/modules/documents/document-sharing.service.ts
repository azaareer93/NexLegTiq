import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import { DocumentAccessService } from './document-access.service';
import { auditRow } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import { AppException, ResourceNotFoundException } from '../../common/errors/app.exception';
import { UnitOfWork } from '../../database/unit-of-work';
import type { ClientInfo } from '../auth/client-info';
import { TimelineService } from '../timeline/timeline.service';

/**
 * `POST /documents/:id/share|unshare` (`share:document`, MVP-98, D-186): whether the file's clients see the document on
 * the portal. Under a lock on the document; a change is audited (UPDATE of `sharedWithClient`) and a share is a
 * DOCUMENT_SHARED timeline event (a confidential document's name stays out of it, D-126). Setting the current value
 * again writes nothing. A quarantined document is never shared (STO-004).
 */
@Injectable()
export class DocumentSharingService {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly documents: DocumentAccessService,
    private readonly uow: UnitOfWork,
    private readonly timeline: TimelineService,
  ) {}

  async setShared(id: string, shared: boolean, client: ClientInfo): Promise<void> {
    const officeId = this.cls.get('officeId');
    const userId = this.cls.get('userId');
    if (!officeId || !userId) throw new Error('No office caller in the request context');
    const document = await this.documents.assertDocumentAccess(id, 'contribute');
    await this.uow.run(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM documents WHERE id = ${id}::uuid AND office_id = ${officeId}::uuid FOR UPDATE`;
      const row = await tx.document.findFirst({
        where: { id, deletedAt: null },
        select: { name: true, status: true, isConfidential: true, sharedWithClient: true },
      });
      if (!row) throw new ResourceNotFoundException();
      if (row.sharedWithClient === shared) return;
      if (shared && row.status === 'QUARANTINED') {
        throw new AppException('STO-004', 'The document was quarantined');
      }
      await tx.document.update({ where: { id }, data: { sharedWithClient: shared } });
      await tx.auditLog.create({
        data: auditRow(
          {
            officeId,
            userId,
            entityType: 'Document',
            entityId: id,
            action: 'UPDATE',
            oldValues: { sharedWithClient: !shared },
            newValues: { sharedWithClient: shared },
          },
          client,
        ),
      });
      if (shared) {
        await this.timeline.record(tx, {
          fileId: document.fileId,
          eventType: 'DOCUMENT_SHARED',
          sourceType: 'Document',
          sourceId: id,
          actorId: userId,
          payload: row.isConfidential ? {} : { name: row.name },
        });
      }
    });
  }
}
