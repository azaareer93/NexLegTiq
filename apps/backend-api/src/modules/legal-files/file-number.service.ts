import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import { FILE_TYPE_CODES, parseFileNumberFormat } from './file-number';
import type { RequestContext } from '../../common/context/request-context';
import { TenantContextMissingError } from '../../common/tenancy/tenant.errors';
import type { ScopedTransaction } from '../../database/unit-of-work';
import type { FileType } from '../../generated/prisma/enums';

type CounterKey = { officeId: string; year: number; typeCode: string };

/**
 * Issues the next file number of the current office (D-031, D-095). Call it inside the transaction that creates the
 * file: the counter row stays locked until that transaction ends, so concurrent creates queue on it, and a rollback gives
 * the number back — numbers are unique and gap-free. The counter is per year and type code when the office's format
 * shows them, otherwise shared (year 0, type ''). `year` is the opening date's year in the office's time zone (D-092).
 * A number some file already has (an earlier format rendering the same text, a soft-deleted file) is skipped, so one
 * clash can never block numbering.
 */
@Injectable()
export class FileNumberService {
  constructor(private readonly cls: ClsService<RequestContext>) {}

  async next(tx: ScopedTransaction, fileType: FileType, year: number): Promise<string> {
    const officeId = this.officeId();
    assertFourDigitYear(year);
    const settings = await tx.officeSettings.findFirst({ select: { fileNumberFormat: true } });
    // A deployment/data fault (signup always creates the row), not a missing resource: 500, not 404.
    if (!settings) throw new Error('Office settings missing: cannot number a file');
    const format = parseFileNumberFormat(settings.fileNumberFormat);
    const key: CounterKey = {
      officeId,
      year: format.usesYear ? year : 0,
      typeCode: format.usesType ? FILE_TYPE_CODES[fileType] : '',
    };
    // ON CONFLICT DO NOTHING creates the counter once; the update then takes the row lock and increments it.
    await tx.fileNumberSequence.createMany({
      data: [{ ...key, lastValue: 0 }],
      skipDuplicates: true,
    });
    for (;;) {
      const fileNumber = format.render({ year, fileType, seq: await this.increment(tx, key) });
      const taken = await tx.legalFile.findFirst({ where: { fileNumber }, select: { id: true } });
      if (!taken) return fileNumber;
    }
  }

  private officeId(): string {
    const officeId = this.cls.isActive() ? this.cls.get('officeId') : undefined;
    if (!officeId) throw new TenantContextMissingError('file number');
    return officeId;
  }

  private async increment(tx: ScopedTransaction, key: CounterKey): Promise<number> {
    const { lastValue } = await tx.fileNumberSequence.update({
      where: { officeId_year_typeCode: key },
      data: { lastValue: { increment: 1 } },
      select: { lastValue: true },
    });
    return lastValue;
  }
}

function assertFourDigitYear(year: number): void {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) {
    throw new RangeError(`File number year must be four digits, got ${year}`);
  }
}
