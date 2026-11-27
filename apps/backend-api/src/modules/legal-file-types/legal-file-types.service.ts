import { Injectable } from '@nestjs/common';
import type { FileTypeOption } from '@nexlegtiq/shared-contracts';

import { PrismaService } from '../../database/prisma.service';

export const ORDER = [{ sortOrder: 'asc' as const }, { nameEn: 'asc' as const }];

/** What an office may pick (D-261): the active types of its country, each with its active sub-types. */
@Injectable()
export class LegalFileTypesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<FileTypeOption[]> {
    const { jurisdiction } = await this.prisma.db.office.findFirstOrThrow({
      select: { jurisdiction: true },
    });
    return this.prisma.db.legalFileType.findMany({
      where: { jurisdiction, isActive: true },
      orderBy: ORDER,
      select: {
        code: true,
        nameAr: true,
        nameEn: true,
        subTypes: {
          where: { isActive: true },
          orderBy: ORDER,
          select: { id: true, nameAr: true, nameEn: true },
        },
      },
    });
  }
}
