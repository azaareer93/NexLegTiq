import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TimelinePageSchema, TimelineQuerySchema } from '@nexlegtiq/shared-contracts';
import type { TimelinePage, TimelineQuery } from '@nexlegtiq/shared-contracts';

import { TimelineService } from './timeline.service';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequireAnyPermission } from '../../common/rbac/permissions.decorator';

const fileId = new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });

/** A file's timeline (D-150): whoever may read the file reads its history. */
@ApiTags('cases')
@ApiBearerAuth('JWT')
@Controller('cases/:id/timeline')
export class TimelineController {
  constructor(private readonly timeline: TimelineService) {}

  @Get()
  @RequireAnyPermission('view:all:cases', 'view:assigned:cases')
  @ApiOperation({
    summary: "A file's events, newest first (cursor = nextCursor of the previous page)",
  })
  @ApiZodResponse(200, TimelinePageSchema)
  list(
    @Param('id', fileId) id: string,
    @Query(new ZodValidationPipe(TimelineQuerySchema)) query: TimelineQuery,
  ): Promise<TimelinePage> {
    return this.timeline.list(id, query);
  }
}
