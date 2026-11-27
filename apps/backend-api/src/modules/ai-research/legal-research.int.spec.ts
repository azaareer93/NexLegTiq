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

import { LegalResearcher } from './legal-researcher';
import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { getQueue, QUEUE } from '../../common/queue/queues';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { AppConfig } from '../../config/app-config';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import type { PrismaClient } from '../../generated/prisma/client';
import { AiCache } from '../ai/ai-cache';
import { AiCostAlert } from '../ai/ai-cost-alert';
import { AiExecutor } from '../ai/ai-executor';
import { AiJobRegistry } from '../ai/ai-job-registry';
import { AiJobs } from '../ai/ai-jobs';
import { AiProviders } from '../ai/ai-providers';
import { AiProcessor } from '../ai/workers/ai.processor';
import { bearerFor } from '../auth/auth.test-helper';
import { liveSubscription } from '../subscriptions/subscription.test-helper';

type Person = { userId: string; officeId: string; role: string };

const PHONE = '0599-123-456';
const SOURCE = { url: 'https://muqtafi.birzeit.edu/law/9', title: 'Labour Law No. 7 of 2000' };

/** D-256 over HTTP on real PostgreSQL and Redis, with the fake research provider (never Perplexity in CI). */
describe('Legal research (integration)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  let providers: AiProviders;
  let processor: AiProcessor;
  let lawyer: Person;
  let outsiderRole: Person;
  let outsider: Person;
  let colleague: Person;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };

  async function seedOffice(name: string, roles: string[]): Promise<Person[]> {
    const office = await raw.office.create({
      data: { name, settings: { create: {} }, subscriptions: liveSubscription() },
    });
    officeIds.push(office.id);
    const people: Person[] = [];
    for (const role of roles) {
      const user = await raw.user.create({
        data: {
          officeId: office.id,
          fullName: `Research ${role}`,
          email: `research-${randomUUID()}@example.test`,
          passwordHash: '!',
          role: role as never,
        },
      });
      people.push({ userId: user.id, officeId: office.id, role });
    }
    return people;
  }

  const ask = (person: Person, body: object) =>
    request(app.getHttpServer()).post('/api/v1/ai/research').set(bearerFor(jwt, person)).send(body);
  const read = (person: Person, jobId: string) =>
    request(app.getHttpServer()).get(`/api/v1/ai/research/${jobId}`).set(bearerFor(jwt, person));

  beforeAll(async () => {
    Object.assign(process.env, integrationEnv(), {
      EMAIL_VERIFICATION_ENFORCED: 'false',
      NODE_ENV: 'test',
      AI_PRIMARY_PROVIDER: 'fake',
      AI_FALLBACK_PROVIDER: 'none',
      AI_RESEARCH_PROVIDER: 'fake',
      BULLMQ_PREFIX: `test-research-${randomUUID().slice(0, 8)}`,
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(app);
    await app.init();
    raw = app.get(PrismaService).unscoped();
    jwt = app.get(JwtService);
    providers = app.get(AiProviders, { strict: false });
    const registry = app.get(AiJobRegistry, { strict: false });
    // The worker provides the researcher; this app is the API, so the test builds it the same way.
    new LegalResearcher(
      app.get(AiExecutor, { strict: false }),
      registry,
      app.get(AiCache, { strict: false }),
      app.get(PrismaService),
      app.get(AppConfig),
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
    [lawyer, outsiderRole, colleague] = (await seedOffice('Research office A', [
      'LAWYER',
      'EXTERNAL_COLLABORATOR',
      'SENIOR_LAWYER',
    ])) as [Person, Person, Person];
    [outsider] = (await seedOffice('Research office B', ['LAWYER'])) as [Person];
  }, 120_000);

  afterAll(async () => {
    if (raw) {
      const where = { officeId: { in: officeIds } };
      await raw.aiUsage.deleteMany({ where });
      await raw.aiJob.deleteMany({ where });
    }
    await app?.close();
    process.env = savedEnv;
  });

  it('queues a question, answers it with citations, keeps it for its creator only and serves a repeat from the cache', async () => {
    const question = `Is ${PHONE} relevant? What notice period applies to ending a work contract? ${randomUUID()}`;
    const queued = await ask(lawyer, { question, language: 'EN' });
    expect(queued.status).toBe(202);
    const { jobId } = queued.body.data as { jobId: string };

    providers.fake.script({
      json: { answer: 'One month in writing.', jurisdictionNote: null },
      sources: [SOURCE],
    });
    const job = (await (getQueue(app, QUEUE.AI) as Queue).getJob(
      `${lawyer.officeId}_${jobId}`,
    )) as Job;
    await processor.process(job);
    expect(JSON.stringify(providers.fake.requests)).not.toContain(PHONE);

    const answer = await read(lawyer, jobId);
    expect(answer.status).toBe(200);
    expect(answer.body.data).toMatchObject({
      answer: 'One month in writing.',
      citations: [{ ...SOURCE, date: null }],
      unsourced: false,
      jurisdiction: 'PALESTINE',
    });
    // Another office (cross-tenant) and a colleague (the job is its creator's) both get 404.
    expect((await read(outsider, jobId)).status).toBe(404);
    expect((await read(colleague, jobId)).status).toBe(404);

    const usage = await raw.aiUsage.findFirstOrThrow({
      where: { officeId: lawyer.officeId, feature: 'legal-research' },
    });
    expect(usage).toMatchObject({ provider: 'fake', succeeded: true });
    const audit = await raw.auditLog.findFirstOrThrow({
      where: { officeId: lawyer.officeId, entityType: 'LegalResearch', entityId: jobId },
    });
    expect(JSON.stringify(audit.newValues)).not.toContain(PHONE);

    const again = await ask(lawyer, { question, language: 'EN' });
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ answer: 'One month in writing.' });
    // The answer cache is the office's: another office asking the same question gets its own job.
    expect((await ask(outsider, { question, language: 'EN' })).status).toBe(202);
  });

  it('refuses holders without use:ai and validates the question', async () => {
    const refused = await ask(outsiderRole, { question: 'Notice period?', language: 'EN' });
    expect([refused.status, refused.body.error.code]).toEqual([403, 'AUTH-100']);
    const invalid = await ask(lawyer, { question: '', language: 'EN', fileId: randomUUID() });
    expect(invalid.status).toBe(400);
  });
});
