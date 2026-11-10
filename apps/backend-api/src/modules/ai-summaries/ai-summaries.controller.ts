import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  AiFeedbackCreatedSchema,
  AiFeedbackSchema,
  AiJobAcceptedSchema,
  AiSummaryListItemSchema,
  AiSummaryQuerySchema,
  AiSummarySchema,
  CreateAiSummarySchema,
} from '@nexlegtiq/shared-contracts';
import type {
  AiFeedbackCreated,
  AiFeedbackRequest,
  AiJobAccepted,
  AiSummary,
  AiSummaryListItem,
  AiSummaryQuery,
  CreateAiSummaryRequest,
} from '@nexlegtiq/shared-contracts';
import type { Response } from 'express';

import { AiSummariesService } from './ai-summaries.service';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequirePermissions } from '../../common/rbac/permissions.decorator';

const summaryId = new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });

/** AI summaries of documents (D-148): asked for here, followed through `GET /jobs/:id` or `document.summary.ready`. */
@ApiTags('ai')
@ApiBearerAuth('JWT')
@Controller('ai/summaries')
export class AiSummariesController {
  constructor(private readonly summaries: AiSummariesService) {}

  @Post()
  @RequirePermissions('use:ai')
  // Each request may queue paid model calls (D-148).
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Summarise a document: 200 with the stored summary of its current version, else 202 with the job (not READY → 422 BIZ-015, quarantined → 422 STO-004, no text → 422 BIZ-020, AI off → 403 AI-005)',
  })
  @ApiZodBody(CreateAiSummarySchema)
  @ApiZodResponse(200, AiSummarySchema)
  @ApiZodResponse(202, AiJobAcceptedSchema)
  async create(
    @Body(new ZodValidationPipe(CreateAiSummarySchema)) body: CreateAiSummaryRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiSummary | AiJobAccepted> {
    const answer = await this.summaries.request(body);
    res.status(answer.status);
    return answer.status === 200 ? answer.summary : answer.accepted;
  }

  @Get()
  @RequirePermissions('use:ai')
  @ApiOperation({
    summary:
      "The latest summary per language of a document's current version (?sourceType&sourceId), or with the document of each, for every document of a file (?fileId)",
  })
  @ApiZodResponse(200, AiSummaryListItemSchema.array())
  list(
    @Query(new ZodValidationPipe(AiSummaryQuerySchema)) query: AiSummaryQuery,
  ): Promise<AiSummary[] | AiSummaryListItem[]> {
    return this.summaries.list(query);
  }

  @Post(':id/feedback')
  @RequirePermissions('use:ai')
  @ApiOperation({ summary: 'Say why a summary was not good (404 unless its document is visible)' })
  @ApiZodBody(AiFeedbackSchema)
  @ApiZodResponse(201, AiFeedbackCreatedSchema)
  feedback(
    @Param('id', summaryId) id: string,
    @Body(new ZodValidationPipe(AiFeedbackSchema)) body: AiFeedbackRequest,
  ): Promise<AiFeedbackCreated> {
    return this.summaries.feedback(id, body);
  }
}
