import { randomUUID } from 'node:crypto';

import { ModuleRef } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Job, Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import request from 'supertest';

import { DocumentSummarizer } from './document-summarizer';
import { PART_CHARS } from './split-text';
import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { getQueue, QUEUE } from '../../common/queue/queues';
import { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { AppConfig } from '../../config/app-config';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { PrismaClient } from '../../generated/prisma/client';
import { AiAccess } from '../ai/ai-access';
import { AiCostAlert } from '../ai/ai-cost-alert';
import { AiExecutor } from '../ai/ai-executor';
import { AiJobRegistry } from '../ai/ai-job-registry';
import { AiJobs } from '../ai/ai-jobs';
import { AiProviders } from '../ai/ai-providers';
import type { AiRequest } from '../ai/providers/ai-provider';
import { AiProcessor } from '../ai/workers/ai.processor';
import { bearerFor } from '../auth/auth.test-helper';
import { liveSubscription } from '../subscriptions/subscription.test-helper';

type Person = { userId: string; officeId: string; role: string };

const SUMMARY = {
  summary: 'A claim for unpaid rent under a lease of a shop in Ramallah, with the defence raised.',
  keyFacts: ['The lease started in 2024.'],
  keyLegalIssues: ['Whether the notice period was respected.'],
  parties: ['[PARTY_1] (plaintiff)'],
  dates: [{ date: '1 March 2024', event: 'Lease signed' }],
};
const NOTES = { summary: 'Notes on one part.', keyFacts: ['A fact.'], keyLegalIssues: [] };

/** D-148 end to end on real PostgreSQL and Redis, with the fake provider (never a real one in CI). */
describe('Document AI summaries (integration)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  let processor: AiProcessor;
  let providers: AiProviders;
  let a1: Person;
  let a2: Person;
  let b1: Person;
  let senior: Person;
  let outsider: Person;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };

  async function seedOffice(name: string) {
    const office = await raw.office.create({
      data: { name, settings: { create: {} }, subscriptions: liveSubscription() },
    });
    officeIds.push(office.id);
    const person = async (role: string): Promise<Person> => {
      const user = await raw.user.create({
        data: {
          officeId: office.id,
          fullName: role === 'LAWYER' ? 'Layla Haddad' : 'Office Manager',
          email: `sum-${randomUUID()}@example.test`,
          passwordHash: '!',
          role: role as never,
        },
      });
      return { userId: user.id, officeId: office.id, role };
    };
    return [await person('OFFICE_MANAGER'), await person('LAWYER'), person] as const;
  }

  /** A READY document on a file whose responsible lawyer is `lawyer`, with `text` as its current version's text. */
  async function documentWith(
    lawyer: Person,
    text: string | null,
    status = 'READY',
    isConfidential = false,
  ) {
    const file = await raw.legalFile.create({
      data: {
        officeId: lawyer.officeId,
        fileNumber: `SUM-${randomUUID()}`,
        title: 'Rent claim',
        fileType: 'LITIGATION',
        responsibleLawyerId: lawyer.userId,
        jurisdiction: 'PALESTINE',
        currency: 'ILS',
      },
    });
    const stored = {
      originalFilename: 'claim.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024n,
      checksumSha256: 'a'.repeat(64),
      storageKey: `${lawyer.officeId}/${file.id}/${randomUUID()}.pdf`,
    };
    const document = await raw.document.create({
      data: {
        officeId: lawyer.officeId,
        fileId: file.id,
        name: 'Statement of claim',
        status: status as never,
        isConfidential,
        documentType: 'PLEADING',
        ...stored,
        uploadedById: lawyer.userId,
      },
    });
    await raw.documentVersion.create({
      data: {
        officeId: lawyer.officeId,
        documentId: document.id,
        versionNumber: 1,
        createdById: lawyer.userId,
        ...stored,
      },
    });
    if (text !== null) {
      await raw.documentText.create({
        data: { officeId: lawyer.officeId, documentId: document.id, versionNumber: 1, text },
      });
    }
    return document;
  }

  const list = (person: Person, sourceId: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/ai/summaries?sourceType=DOCUMENT&sourceId=${sourceId}`)
      .set(bearerFor(jwt, person));

  const post = (person: Person, body: object) =>
    request(app.getHttpServer())
      .post('/api/v1/ai/summaries')
      .set(bearerFor(jwt, person))
      .send(body);

  /** Runs the queued job the way the worker does. */
  async function runQueued(person: Person, jobId: string): Promise<void> {
    const job = (await (getQueue(app, QUEUE.AI) as Queue).getJob(
      `${person.officeId}_${jobId}`,
    )) as Job;
    try {
      await processor.process(job);
    } catch (error) {
      job.attemptsMade = job.opts.attempts ?? 1;
      await processor.onFailed(job, error as Error);
    }
  }

  beforeAll(async () => {
    Object.assign(process.env, integrationEnv(), {
      EMAIL_VERIFICATION_ENFORCED: 'false',
      NODE_ENV: 'test',
      AI_PRIMARY_PROVIDER: 'fake',
      AI_FALLBACK_PROVIDER: 'none',
      BULLMQ_PREFIX: `test-sum-${randomUUID().slice(0, 8)}`,
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(app);
    await app.init();
    // unscoped: fixtures for two offices and checks across them.
    raw = app.get(PrismaService).unscoped();
    jwt = app.get(JwtService);
    providers = app.get(AiProviders, { strict: false });
    const registry = app.get(AiJobRegistry, { strict: false });
    // The worker provides the summarizer; this app is the API, so the test builds it the same way.
    new DocumentSummarizer(
      app.get(AiExecutor, { strict: false }),
      app.get(AiAccess, { strict: false }),
      app.get(PrismaService),
      app.get(UnitOfWork),
      app.get(RealtimePublisher),
      registry,
      app.get(ClsService),
    ).onModuleInit();
    processor = new AiProcessor(
      app.get(TenantRunner),
      app.get(PrismaService),
      await app.resolve(PinoLogger),
      registry,
      app.get(AiJobs, { strict: false }),
      app.get(AiCostAlert, { strict: false }),
      app.get(AppConfig),
      app.get(ModuleRef),
    );
    let person: (role: string) => Promise<Person>;
    [a1, a2, person] = await seedOffice('Summary office A');
    senior = await person('SENIOR_LAWYER');
    outsider = await person('EXTERNAL_COLLABORATOR');
    [b1] = await seedOffice('Summary office B');
    providers.fake.define('document-summary', (req: AiRequest) =>
      req.system.includes('The material is part') ? NOTES : SUMMARY,
    );
  }, 120_000);

  afterEach(() => providers.fake.requests.splice(0));

  afterAll(async () => {
    if (!raw) return;
    for (const table of [
      'aiSummary',
      'aiUsage',
      'aiJob',
      'caseTimelineEvent',
      'documentText',
      'documentVersion',
      'document',
    ] as const) {
      await (raw[table] as unknown as { deleteMany(a: object): Promise<unknown> }).deleteMany({
        where: { officeId: { in: officeIds } },
      });
    }
    await app.close();
    process.env = savedEnv;
  });

  it('should queue a summary, store it with the model facts and a timeline event, then answer 200 from it', async () => {
    const document = await documentWith(
      a2,
      'Layla Haddad claims unpaid rent for the shop. '.repeat(40),
    );
    const queued = await post(a2, {
      sourceType: 'DOCUMENT',
      sourceId: document.id,
      language: 'EN',
    });
    expect(queued.status).toBe(202);
    await runQueued(a2, queued.body.data.jobId);
    // The lawyer's own name never reaches the provider (D-131).
    expect(providers.fake.requests.map((r) => r.user).join()).not.toContain('Layla Haddad');
    const stored = await raw.aiSummary.findFirstOrThrow({ where: { sourceId: document.id } });
    expect(stored).toMatchObject({
      language: 'EN',
      versionNumber: 1,
      provider: 'fake',
      promptVersion: 'document-summary.v1',
      chunks: 1,
      createdById: a2.userId,
    });
    // Re-hydrated on the way back.
    expect(stored.parties).toEqual(['Layla Haddad (plaintiff)']);
    await expect(
      raw.caseTimelineEvent.count({
        where: { fileId: document.fileId, eventType: 'SUMMARY_GENERATED' },
      }),
    ).resolves.toBe(1);

    const again = await post(a2, { sourceType: 'DOCUMENT', sourceId: document.id, language: 'EN' });
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ id: stored.id, chunks: 1, keyFacts: SUMMARY.keyFacts });
    const listed = await list(a1, document.id);
    expect(listed.body.data.map((row: { id: string }) => row.id)).toEqual([stored.id]);
  });

  it('should read a long document in parts and count one operation against the quota', async () => {
    const paragraph = `${'نص الدعوى. '.repeat(500)}\n\n`;
    const document = await documentWith(
      a2,
      paragraph.repeat(Math.ceil((PART_CHARS * 2.5) / paragraph.length)),
    );
    const before = new Date();
    const queued = await post(a2, {
      sourceType: 'DOCUMENT',
      sourceId: document.id,
      language: 'AR',
    });
    await runQueued(a2, queued.body.data.jobId);
    const requests = providers.fake.requests;
    expect(requests.filter((r) => r.system.includes('The material is part'))).toHaveLength(3);
    expect(requests.at(-1)?.system).toContain('Merge them');
    expect(requests.every((r) => r.user.startsWith('<material>'))).toBe(true);
    expect(requests.every((r) => r.system.includes('Modern Standard Arabic'))).toBe(true);
    const stored = await raw.aiSummary.findFirstOrThrow({ where: { sourceId: document.id } });
    expect(stored).toMatchObject({ language: 'AR', chunks: 3 });
    const usage = await raw.aiUsage.findMany({
      where: {
        officeId: a2.officeId,
        feature: 'document-summary',
        createdAt: { gte: before },
      },
      select: { partial: true },
    });
    expect(usage.filter((row) => row.partial)).toHaveLength(3);
    expect(usage.filter((row) => !row.partial)).toHaveLength(1);
  });

  it('should refuse a document not ready, without text, quarantined, of another office, or with AI off', async () => {
    const processing = await documentWith(a2, 'Text.', 'PROCESSING');
    const empty = await documentWith(a2, null);
    const quarantined = await documentWith(a2, 'Text.', 'QUARANTINED');
    const body = (id: string) => ({ sourceType: 'DOCUMENT', sourceId: id, language: 'EN' });
    expect((await post(a2, body(processing.id))).body.error.code).toBe('BIZ-015');
    expect((await post(a2, body(empty.id))).body.error.code).toBe('BIZ-020');
    expect((await post(a2, body(quarantined.id))).body.error.code).toBe('STO-004');
    const other = await post(b1, body(empty.id));
    expect([other.status, other.body.error.code]).toEqual([404, 'RES-001']);
    expect((await post(a2, { ...body(empty.id), sourceType: 'SESSION' })).status).toBe(400);
    await raw.officeSettings.update({
      where: { officeId: a2.officeId },
      data: { enableAi: false },
    });
    try {
      expect((await post(a2, body(empty.id))).body.error.code).toBe('AI-005');
    } finally {
      await raw.officeSettings.update({
        where: { officeId: a2.officeId },
        data: { enableAi: true },
      });
    }
  });

  it('should join a summary already queued, and treat a new version as not summarised', async () => {
    const document = await documentWith(a2, 'Layla Haddad claims unpaid rent. '.repeat(40));
    const body = { sourceType: 'DOCUMENT', sourceId: document.id, language: 'EN' };
    const first = await post(a2, body);
    const second = await post(a2, body);
    expect(second.body.data.jobId).toBe(first.body.data.jobId);
    await runQueued(a2, first.body.data.jobId);
    expect((await list(a2, document.id)).body.data).toHaveLength(1);
    await raw.documentVersion.create({
      data: {
        officeId: a2.officeId,
        documentId: document.id,
        versionNumber: 2,
        createdById: a2.userId,
        originalFilename: 'claim-2.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024n,
        checksumSha256: 'b'.repeat(64),
        storageKey: `${a2.officeId}/${document.fileId}/${randomUUID()}.pdf`,
      },
    });
    await raw.documentText.create({
      data: { officeId: a2.officeId, documentId: document.id, versionNumber: 2, text: 'New text.' },
    });
    await raw.document.update({ where: { id: document.id }, data: { currentVersion: 2 } });
    expect((await list(a2, document.id)).body.data).toEqual([]);
    expect((await post(a2, body)).status).toBe(202);
  });

  it('should hide summaries from those who may not use AI, see the document, or belong to another office', async () => {
    const document = await documentWith(
      a2,
      'Text of a confidential claim. '.repeat(40),
      'READY',
      true,
    );
    const body = { sourceType: 'DOCUMENT', sourceId: document.id, language: 'EN' };
    const refused = await post(outsider, body);
    expect([refused.status, refused.body.error.code]).toEqual([403, 'AUTH-100']);
    expect((await list(outsider, document.id)).status).toBe(403);
    // A senior lawyer sees every file, but not a confidential document they are not on (D-126).
    expect((await post(senior, body)).status).toBe(404);
    expect((await list(senior, document.id)).status).toBe(404);
    expect((await list(b1, document.id)).status).toBe(404);
    expect((await post(a1, body)).status).toBe(202);
    await expect(
      raw.aiJob.count({ where: { createdById: { in: [outsider.userId, senior.userId] } } }),
    ).resolves.toBe(0);
  });
});
