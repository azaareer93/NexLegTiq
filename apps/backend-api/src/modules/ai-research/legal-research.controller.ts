import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  AiJobAcceptedSchema,
  CreateLegalResearchSchema,
  LegalResearchSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  AiJobAccepted,
  CreateLegalResearchRequest,
  LegalResearch,
} from '@nexlegtiq/shared-contracts';
import type { Response } from 'express';

import { LegalResearchService } from './legal-research.service';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequirePermissions } from '../../common/rbac/permissions.decorator';

const jobId = new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });

/** Legal research over web sources (D-256): asked here, followed through `GET /jobs/:id` or `ai.job.completed`. */
@ApiTags('ai')
@ApiBearerAuth('JWT')
@Controller('ai/research')
export class LegalResearchController {
  constructor(private readonly research: LegalResearchService) {}

  @Post()
  @RequirePermissions('use:ai')
  // Each request may queue paid web-search calls.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Ask a general legal question (no case data): 200 when the same question was answered recently, else 202 with the job (research off → 503 AI-001, AI off → 403 AI-005)',
  })
  @ApiZodBody(CreateLegalResearchSchema)
  @ApiZodResponse(200, LegalResearchSchema)
  @ApiZodResponse(202, AiJobAcceptedSchema)
  async create(
    @Body(new ZodValidationPipe(CreateLegalResearchSchema)) body: CreateLegalResearchRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LegalResearch | AiJobAccepted> {
    const answer = await this.research.request(body);
    res.status(answer.status);
    return answer.status === 200 ? answer.research : answer.accepted;
  }

  @Get(':jobId')
  @RequirePermissions('use:ai')
  @ApiOperation({ summary: "The answer of the caller's research job, kept 24 h (else 404)" })
  @ApiZodResponse(200, LegalResearchSchema)
  get(@Param('jobId', jobId) id: string): Promise<LegalResearch> {
    return this.research.get(id);
  }
}
