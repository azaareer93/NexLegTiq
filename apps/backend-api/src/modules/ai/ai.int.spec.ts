import { randomUUID } from 'node:crypto';

import { ModuleRef } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { OfficeId, UserId } from '@nexlegtiq/shared-types';
import type { Job, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import { z } from 'zod';

import { AiCostAlert } from './ai-cost-alert';
import { AiExecutor } from './ai-executor';
import { AiJobRegistry } from './ai-job-registry';
import { AiJobs } from './ai-jobs';
import { AiProviders } from './ai-providers';
import { AiProcessor } from './workers/ai.processor';
import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { AppException } from '../../common/errors/app.exception';
import { getQueue, QUEUE } from '../../common/queue/queues';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { AppConfig } from '../../config/app-config';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import type { PrismaClient } from '../../generated/prisma/client';
import { bearerFor } from '../auth/auth.test-helper';
import { liveSubscription } from '../subscriptions/subscription.test-helper';

type Person = { userId: string; officeId: string; role: string };

const Answer = z.object({ summary: z.string().min(1) });

/** D-130 end to end on real PostgreSQL and Redis, with the fake provider (never a real one in CI). */
describe('AI foundation (integration)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let tenant: TenantRunner;
  let executor: AiExecutor;
  let jobs: AiJobs;
  let registry: AiJobRegistry;
  let processor: AiProcessor;
  let providers: AiProviders;
  let a1: Person;
  let a2: Person;
  let b1: Person;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };

  async function seedOffice(name: string, subscriptions: object = liveSubscription()) {
    const office = await raw.office.create({
      data: { name, settings: { create: {} }, subscriptions },
    });
    officeIds.push(office.id);
    const person = async (role: string): Promise<Person> => {
      const user = await raw.user.create({
        data: {
          officeId: office.id,
          fullName: role,
          email: `ai-${randomUUID()}@example.test`,
          passwordHash: '!',
          role: role as never,
        },
      });
      return { userId: user.id, officeId: office.id, role };
    };
    return [await person('OFFICE_MANAGER'), await person('LAWYER')] as const;
  }

  const as = <T>(person: Person, work: () => Promise<T>): Promise<T> =>
    tenant.run({ officeId: person.officeId as OfficeId, userId: person.userId as UserId }, work);

  const ask = (person: Person, cacheKey?: string[]) =>
    as(person, () =>
      executor.execute({
        feature: 'int-summary',
        prompt: { version: 'int.v1', system: 'Summarise.', user: 'The lease ended.' },
        schema: Answer,
        redactionContext: { names: [] },
        ...(cacheKey ? { cacheKey } : {}),
        userId: person.userId,
      }),
    );

  const queuedJob = (person: Person, id: string): Promise<Job | undefined> =>
    (getQueue(app, QUEUE.AI) as Queue).getJob(`${person.officeId}_${id}`);

  /** Runs a queued job the way the worker does, then the `failed` hook BullMQ would call on a final failure. */
  async function runJob(job: Job): Promise<void> {
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
      BULLMQ_PREFIX: `test-ai-${randomUUID().slice(0, 8)}`,
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(app);
    await app.init();
    // unscoped: fixtures for three offices and checks across them.
    raw = app.get(PrismaService).unscoped();
    tenant = app.get(TenantRunner);
    executor = app.get(AiExecutor, { strict: false });
    jobs = app.get(AiJobs, { strict: false });
    registry = app.get(AiJobRegistry, { strict: false });
    providers = app.get(AiProviders, { strict: false });
    processor = new AiProcessor(
      tenant,
      app.get(PrismaService),
      await app.resolve(PinoLogger),
      registry,
      jobs,
      app.get(AiCostAlert, { strict: false }),
      app.get(AppConfig),
      app.get(ModuleRef),
    );
    [a1, a2] = await seedOffice('AI office A');
    [b1] = await seedOffice('AI office B');
    registry.register('int-summarize', async (data, context) => {
      if (data['fail']) throw new AppException(data['fail'] as never, 'scripted');
      const { value } = await executor.execute({
        feature: 'int-summary',
        prompt: { version: 'int.v1', system: 's', user: String(data['text']) },
        schema: Answer,
        redactionContext: { names: [] },
        userId: context.userId,
        signal: context.signal,
      });
      return { length: value.summary.length };
    });
  });

  afterEach(() => providers.fake.reset());

  afterAll(async () => {
    if (raw) {
      const where = { officeId: { in: officeIds } };
      await raw.aiUsage.deleteMany({ where });
      await raw.aiJob.deleteMany({ where });
      await raw.subscription.deleteMany({ where });
      await raw.officeSettings.deleteMany({ where });
      await raw.user.deleteMany({ where });
      await raw.office.deleteMany({ where: { id: { in: officeIds } } });
    }
    await app?.close();
    process.env = savedEnv;
  });

  it('should answer through the fake provider, record usage, and serve the cache next time', async () => {
    providers.fake.script({ json: { summary: 'Ended.' } });
    const key = ['int', randomUUID()];
    await expect(ask(a1, key)).resolves.toMatchObject({
      value: { summary: 'Ended.' },
      cached: false,
    });
    await expect(ask(a1, key)).resolves.toMatchObject({
      value: { summary: 'Ended.' },
      cached: true,
    });
    expect(providers.fake.requests).toHaveLength(1);
    // Another office never reads A's cache entry (o:{officeId}: keys, D-058).
    providers.fake.script({ json: { summary: 'Own answer.' } });
    await expect(ask(b1, key)).resolves.toMatchObject({
      value: { summary: 'Own answer.' },
      cached: false,
    });
    const rows = await raw.aiUsage.findMany({
      where: { officeId: a1.officeId },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((row) => [row.cached, row.provider, row.userId])).toEqual([
      [false, 'fake', a1.userId],
      [true, 'fake', a1.userId],
    ]);
    expect(rows[0]?.inputTokens).toBeGreaterThan(0);
  });

  it('should refuse AI when the office switched it off (AI-005) or used its monthly quota (AUTH-103)', async () => {
    const [manager] = await seedOffice('AI office quota', {
      create: {
        status: 'ACTIVE',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 86_400_000),
        plan: { connect: { code: 'PS_FREE' } },
      },
    });
    const plan = await raw.plan.findUniqueOrThrow({ where: { code: 'PS_FREE' } });
    await raw.aiUsage.createMany({
      data: Array.from({ length: plan.aiQuotaMonthly ?? 0 }, () => ({
        officeId: manager.officeId,
        feature: 'int-summary',
        provider: 'fake',
        model: 'fake-1',
        inputTokens: 1,
        outputTokens: 1,
        costUsd: '0',
        durationMs: 1,
      })),
    });
    await expect(ask(manager)).rejects.toMatchObject({ code: 'AUTH-103' });
    await raw.officeSettings.update({
      where: { officeId: manager.officeId },
      data: { enableAi: false },
    });
    await expect(ask(manager)).rejects.toMatchObject({ code: 'AI-005' });
    expect(providers.fake.requests).toHaveLength(0);
  });

  it('should run a queued job to SUCCEEDED and show it only to its creator', async () => {
    providers.fake.script({ json: { summary: 'Done.' } });
    const accepted = await as(a1, () =>
      jobs.enqueue({
        type: 'int-summarize',
        sourceType: 'DOCUMENT',
        sourceId: randomUUID(),
        fields: { text: 'x' },
      }),
    );
    expect(accepted).toEqual({ jobId: expect.any(String), status: 'QUEUED' });
    const job = await queuedJob(a1, accepted.jobId);
    expect(job?.data).toMatchObject({ aiJobId: accepted.jobId, text: 'x', officeId: a1.officeId });
    await runJob(job as Job);

    const jwt = app.get(JwtService);
    const get = (person: Person, id = accepted.jobId) =>
      request(app.getHttpServer()).get(`/api/v1/jobs/${id}`).set(bearerFor(jwt, person));
    const mine = await get(a1).expect(200);
    expect(mine.body.data).toMatchObject({
      id: accepted.jobId,
      type: 'int-summarize',
      status: 'SUCCEEDED',
      sourceType: 'DOCUMENT',
      errorCode: null,
      result: { length: 5 },
    });
    expect(mine.body.data.finishedAt).toMatch(/Z$/);
    // A colleague (the job may concern a file they cannot see), another office, a malformed id: 404.
    await get(a2).expect(404);
    await get(b1).expect(404);
    await get(a1, 'not-a-uuid').expect(404);
  });

  it('should mark a job FAILED with the error code: at once for a final error, on the last attempt otherwise', async () => {
    const final = await as(a1, () =>
      jobs.enqueue({ type: 'int-summarize', fields: { fail: 'AI-004' } }),
    );
    await runJob((await queuedJob(a1, final.jobId)) as Job);
    const retryable = await as(a1, () =>
      jobs.enqueue({ type: 'int-summarize', fields: { fail: 'AI-002' } }),
    );
    const job = (await queuedJob(a1, retryable.jobId)) as Job;
    // A first failed attempt of a retryable error is rethrown as is (BullMQ retries it).
    await expect(processor.process(job)).rejects.toMatchObject({ code: 'AI-002' });
    expect((await raw.aiJob.findUniqueOrThrow({ where: { id: retryable.jobId } })).status).toBe(
      'RUNNING',
    );
    await runJob(job);
    const unknown = await as(a1, () => jobs.enqueue({ type: 'int-nobody-handles' }));
    await runJob((await queuedJob(a1, unknown.jobId)) as Job);

    const rows = await raw.aiJob.findMany({
      where: { id: { in: [final.jobId, retryable.jobId, unknown.jobId] } },
      select: { id: true, status: true, errorCode: true, attempts: true },
    });
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId[final.jobId]).toMatchObject({ status: 'FAILED', errorCode: 'AI-004', attempts: 1 });
    expect(byId[retryable.jobId]).toMatchObject({
      status: 'FAILED',
      errorCode: 'AI-002',
      attempts: 2,
    });
    expect(byId[unknown.jobId]).toMatchObject({ status: 'FAILED', errorCode: 'SYS-001' });
  });

  it('should not queue work for an office that switched AI off', async () => {
    const [manager] = await seedOffice('AI office off');
    await raw.officeSettings.update({
      where: { officeId: manager.officeId },
      data: { enableAi: false },
    });
    await expect(as(manager, () => jobs.enqueue({ type: 'int-summarize' }))).rejects.toMatchObject({
      code: 'AI-005',
    });
    expect(await raw.aiJob.count({ where: { officeId: manager.officeId } })).toBe(0);
  });
});
