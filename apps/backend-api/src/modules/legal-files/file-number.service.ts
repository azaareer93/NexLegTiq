import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import { FILE_TYPE_CODES, parseFileNumberFormat } from './file-number';
import type { RequestContext } from '../../common/context/request-context';
import { TenantContextMissingError } from '../../common/tenancy/tenant.errors';
import type { ScopedTransaction } from '../../database/unit-of-work';
import type { FileType } from '../../generated/prisma/enums';

/**
 * Issues the next file number of the current office (D-031, D-095). Call it inside the transaction that creates the
 * file: the counter row stays locked until that transaction ends, so concurrent creates queue on it, and a rollback gives
 * the number back — numbers are unique and gap-free. The counter is per year and type code when the office's format
 * shows them, otherwise shared (year 0, type '').
 */
@Injectable()
export class FileNumberService {
  constructor(private readonly cls: ClsService<RequestContext>) {}

  async next(tx: ScopedTransaction, fileType: FileType, year: number): Promise<string> {
    const officeId = this.cls.isActive() ? this.cls.get('officeId') : undefined;
    if (!officeId) throw new TenantContextMissingError('file number');
    const settings = await tx.officeSettings.findFirstOrThrow({
      select: { fileNumberFormat: true },
    });
    const format = parseFileNumberFormat(settings.fileNumberFormat);
    const key = {
      officeId,
      year: format.usesYear ? year : 0,
      typeCode: format.usesType ? FILE_TYPE_CODES[fileType] : '',
    };
    // ON CONFLICT DO NOTHING creates the counter once; the update then takes the row lock and increments it.
    await tx.fileNumberSequence.createMany({
      data: [{ ...key, lastValue: 0 }],
      skipDuplicates: true,
    });
    const { lastValue } = await tx.fileNumberSequence.update({
      where: { officeId_year_typeCode: key },
      data: { lastValue: { increment: 1 } },
      select: { lastValue: true },
    });
    return format.render({ year, fileType, seq: lastValue });
  }
}
