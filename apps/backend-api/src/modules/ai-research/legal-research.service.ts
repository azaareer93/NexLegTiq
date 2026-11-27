import { Inject, Injectable } from '@nestjs/common';
import type {
  AiJobAccepted,
  CreateLegalResearchRequest,
  LegalResearch,
} from '@nexlegtiq/shared-contracts';
import { LegalResearchSchema } from '@nexlegtiq/shared-contracts';
import type { OfficeId } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';

import {
  LEGAL_RESEARCH_JOB,
  officeRedactionContext,
  researchHash,
  researchKeys,
} from './legal-research';
import { AuditService } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { PrismaService } from '../../database/prisma.service';
import { AiAccess } from '../ai/ai-access';
import { AiCache } from '../ai/ai-cache';
import { AiJobs } from '../ai/ai-jobs';
import { LEGAL_RESEARCH_V1 } from '../ai/prompts/legal-research.v1';
import { AI_REDACTOR } from '../ai/redaction';
import type { AiRedactor } from '../ai/redaction';

export type ResearchAnswer =
  | { readonly status: 200; readonly research: LegalResearch }
  | { readonly status: 202; readonly accepted: AiJobAccepted };

/**
 * Legal research requests (D-256): a general question, never case data. The platform switch (AI-001) and the office's
 * AI checks run first; the same question answered within the cache time comes back at once (200), else a job is queued
 * (202) and audited with the question redacted.
 */
@Injectable()
export class LegalResearchService {
  constructor(
    private readonly access: AiAccess,
    private readonly jobs: AiJobs,
    private readonly cache: AiCache,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<RequestContext>,
    @Inject(AI_REDACTOR) private readonly redactor: AiRedactor,
  ) {}

  async request(body: CreateLegalResearchRequest): Promise<ResearchAnswer> {
    this.access.assertResearch();
    await this.access.assertEnabled();
    const jurisdiction =
      body.jurisdiction ??
      (await this.prisma.db.office.findFirstOrThrow({ select: { jurisdiction: true } }))
        .jurisdiction;
    const fields = { question: body.question, language: body.language, jurisdiction };
    const hash = researchHash(fields, LEGAL_RESEARCH_V1.version);
    const hit = LegalResearchSchema.safeParse(
      await this.cache.get(this.officeId(), researchKeys.question(hash)),
    );
    if (hit.success) return { status: 200, research: hit.data };
    const accepted = await this.jobs.enqueue({
      type: LEGAL_RESEARCH_JOB,
      fields: { ...fields, hash },
      dedupeKey: `research:${hash}`,
    });
    // The audit keeps what the provider is sent — the redacted question, never the typed PII.
    const [question = ''] = this.redactor.redact(
      [body.question],
      await officeRedactionContext(this.prisma),
    ).texts;
    await this.audit.log(this.prisma.db, {
      entityType: 'LegalResearch',
      entityId: accepted.jobId,
      action: 'CREATE',
      newValues: { question, language: body.language, jurisdiction },
    });
    return { status: 202, accepted };
  }

  /** The answer of the caller's own job while it is kept (24 h); else 404. */
  async get(jobId: string): Promise<LegalResearch> {
    await this.jobs.get(jobId);
    const found = LegalResearchSchema.safeParse(
      await this.cache.get(this.officeId(), researchKeys.job(jobId)),
    );
    if (!found.success) throw new ResourceNotFoundException();
    return found.data;
  }

  private officeId(): OfficeId {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the context of legal research');
    return officeId;
  }
}
