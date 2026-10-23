import { Injectable } from '@nestjs/common';
import type { UserId } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';

import { auditRow } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import { BusinessRuleException } from '../../common/errors/app.exception';
import { isPrismaError } from '../../common/errors/prisma-error';
import type { ClientInfo } from '../auth/client-info';

/** Caller, office and audit rows for courts, judges and prosecutors (MVP-66, D-115). */
@Injectable()
export class ReferenceContext {
  constructor(private readonly cls: ClsService<RequestContext>) {}

  // A missing caller or office is a programming error (guarded routes always set them): 500 SYS-001.
  officeId(): string {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the request context');
    return officeId;
  }

  private actorId(): UserId {
    const userId = this.cls.get('userId');
    if (!userId) throw new Error('No caller in the request context');
    return userId;
  }

  auditRow(
    caller: ClientInfo,
    entityType: 'Court' | 'Judge' | 'PublicProsecutor',
    entityId: string,
    action: 'CREATE' | 'UPDATE' | 'DELETE',
    oldValues: Record<string, unknown> | null,
    newValues: Record<string, unknown> | null,
  ) {
    return auditRow(
      {
        officeId: this.officeId(),
        userId: this.actorId(),
        entityType,
        entityId,
        action,
        oldValues,
        newValues,
      },
      caller,
    );
  }
}

/** A delete refused by a foreign key (a file or judge still points at the row) is 422 BIZ-011, not a 500. */
export async function deleteOrInUse(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (isPrismaError(error) && error.code === 'P2003') {
      throw new BusinessRuleException('BIZ-011', 'The record is still referenced');
    }
    throw error;
  }
}
