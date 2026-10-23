import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AiJobSchema } from '@nexlegtiq/shared-contracts';
import type { AiJob } from '@nexlegtiq/shared-contracts';

import { AiJobs } from './ai-jobs';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequirePermissions } from '../../common/rbac/permissions.decorator';

/** A malformed id is the same 404 as an unknown one (D-019). */
const jobId = new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });

/** Asynchronous AI jobs (api-conventions.md, D-014, D-130): polled here or followed over the realtime socket. */
@ApiTags('ai')
@ApiBearerAuth('JWT')
@Controller('jobs')
export class AiJobsController {
  constructor(private readonly jobs: AiJobs) {}

  @Get(':id')
  @RequirePermissions('use:ai')
  @ApiOperation({ summary: 'An AI job of the caller: status, error code and what it produced' })
  @ApiZodResponse(200, AiJobSchema)
  get(@Param('id', jobId) id: string): Promise<AiJob> {
    return this.jobs.get(id);
  }
}
