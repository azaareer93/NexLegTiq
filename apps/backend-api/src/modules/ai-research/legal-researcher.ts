import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type { LegalResearch } from '@nexlegtiq/shared-contracts';
import type { OfficeId } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';

import {
  LEGAL_RESEARCH_FEATURE,
  LEGAL_RESEARCH_JOB,
  LegalResearchFieldsSchema,
  officeRedactionContext,
  RESEARCH_JOB_TTL_SECONDS,
  researchKeys,
} from './legal-research';
import { JURISDICTION_NAMES, LEGAL_SOURCES } from './legal-sources';
import type { RequestContext } from '../../common/context/request-context';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import { AiCache } from '../ai/ai-cache';
import { AiExecutor, BaseAiService } from '../ai/ai-executor';
import { AiJobRegistry } from '../ai/ai-job-registry';
import type { AiJobContext } from '../ai/ai-job-registry';
import { LEGAL_RESEARCH_V1, LegalResearchOutputSchema } from '../ai/prompts/legal-research.v1';

/**
 * Answers a research question in the worker (D-256): searched first on the official legal sources of the jurisdiction,
 * then — only when that found nothing — on the open web (a second paid call). The citations are the pages the search
 * found; none → `unsourced`. The answer is kept for the job's creator (24 h) and under the question (cache TTL).
 */
@Injectable()
export class LegalResearcher extends BaseAiService implements OnModuleInit {
  constructor(
    executor: AiExecutor,
    private readonly registry: AiJobRegistry,
    private readonly cache: AiCache,
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly cls: ClsService<RequestContext>,
  ) {
    super(executor);
  }

  onModuleInit(): void {
    this.registry.register(LEGAL_RESEARCH_JOB, (data, context) => this.run(data, context));
  }

  async run(
    data: Record<string, unknown>,
    context: AiJobContext,
  ): Promise<Record<string, unknown>> {
    const fields = LegalResearchFieldsSchema.parse(data);
    const prompt = LEGAL_RESEARCH_V1.build({
      question: fields.question,
      language: fields.language,
      jurisdiction: JURISDICTION_NAMES[fields.jurisdiction],
    });
    const redactionContext = await officeRedactionContext(this.prisma);
    const ask = (domains: readonly string[], partial: boolean) =>
      this.execute({
        feature: LEGAL_RESEARCH_FEATURE,
        prompt,
        schema: LegalResearchOutputSchema,
        redactionContext,
        webSearch: { domains },
        userId: context.userId,
        signal: context.signal,
        partial,
      });
    const official = LEGAL_SOURCES[fields.jurisdiction];
    let result = await ask(official, false);
    // The open-web retry is paid and recorded, but one question counts once against the quota (D-148).
    if (official.length > 0 && result.sources.length === 0) result = await ask([], true);
    const research: LegalResearch = {
      answer: result.value.answer,
      citations: result.sources.map((source) => ({
        url: source.url,
        title: source.title,
        date: source.date ?? null,
      })),
      jurisdictionNote: result.value.jurisdictionNote,
      unsourced: result.sources.length === 0,
      jurisdiction: fields.jurisdiction,
      language: fields.language,
      provider: result.provider,
      model: result.model,
      promptVersion: result.promptVersion,
      createdAt: new Date().toISOString(),
    };
    const officeId = this.officeId();
    await this.cache.set(
      officeId,
      researchKeys.job(context.aiJobId),
      research,
      RESEARCH_JOB_TTL_SECONDS,
    );
    await this.cache.set(
      officeId,
      researchKeys.question(fields.hash),
      research,
      this.config.ai.cacheTtlSeconds,
    );
    return { citations: research.citations.length };
  }

  private officeId(): OfficeId {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the context of legal research');
    return officeId;
  }
}
