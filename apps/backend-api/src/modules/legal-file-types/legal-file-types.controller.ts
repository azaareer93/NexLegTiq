import { Controller, Get, HttpStatus } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FileTypeOptionSchema } from '@nexlegtiq/shared-contracts';
import type { FileTypeOption } from '@nexlegtiq/shared-contracts';
import { z } from 'zod';

import { LegalFileTypesService } from './legal-file-types.service';
import { ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequireAnyPermission } from '../../common/rbac/permissions.decorator';
import { READ_REFERENCE } from '../courts/reference-permissions';

/** Legal file types are platform reference data (MVP-175, D-261): read like courts, by everyone who sees files. */
@ApiTags('file-types')
@ApiBearerAuth('JWT')
@Controller('file-types')
export class LegalFileTypesController {
  constructor(private readonly types: LegalFileTypesService) {}

  @Get()
  @RequireAnyPermission(...READ_REFERENCE)
  @ApiOperation({ summary: "Active file types and sub-types of the office's country, in order" })
  @ApiZodResponse(HttpStatus.OK, z.array(FileTypeOptionSchema))
  list(): Promise<FileTypeOption[]> {
    return this.types.list();
  }
}
