import { Decimal } from 'decimal.js';
import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import { LEGAL_RESEARCH_JOB, researchHash, researchKeys } from './legal-research';
import { LegalResearchService } from './legal-research.service';
import { LegalResearcher } from './legal-researcher';
import { LEGAL_SOURCES } from './legal-sources';
import type { AuditService } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';
import type { PrismaService } from '../../database/prisma.service';
import { AiAccess } from '../ai/ai-access';
import type { AiCache } from '../ai/ai-cache';
import { AiExecutor } from '../ai/ai-executor';
import type { AiJobRegistry } from '../ai/ai-job-registry';
import type { AiJobs } from '../ai/ai-jobs';
import { AiProviders } from '../ai/ai-providers';
import type { AiUsageRecorder } from '../ai/ai-usage';
import { PiiRedactor } from '../ai/pii-redactor';
import { LEGAL_RESEARCH_V1 } from '../ai/prompts/legal-research.v1';
import type { EntitlementsService } from '../subscriptions/entitlements.service';

const OFFICE = '01900000-0000-7000-8000-0000000000aa';
const JOB = '01900000-0000-7000-8000-0000000000bb';
const CLIENT = 'Ahmad Saleh Odeh';
const PHONE = '0599-123-456';
const EMAIL = 'ahmad.odeh@example.com';
const QUESTION = `My client ${CLIENT} (${PHONE}, ${EMAIL}) lost at first instance. How long does he have to appeal?`;
const SOURCE = {
  url: 'https://muqtafi.birzeit.edu/law/1',
  title: 'Civil Procedure Law',
  date: '2001-01-01',
};

function setup(research = 'fake') {
  const config = new AppConfig(
    parseEnv(
      testEnv({ NODE_ENV: 'test', AI_PRIMARY_PROVIDER: 'fake', AI_RESEARCH_PROVIDER: research }),
    ),
  );
  const providers = new AiProviders(config, {
    setContext: jest.fn(),
    warn: jest.fn(),
  } as unknown as PinoLogger);
  const prisma = {
    db: {
      officeSettings: { findFirst: jest.fn().mockResolvedValue({ enableAi: true }) },
      office: { findFirstOrThrow: jest.fn().mockResolvedValue({ jurisdiction: 'PALESTINE' }) },
      client: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { clientType: 'INDIVIDUAL', displayName: CLIENT, fullName: CLIENT, companyName: null },
          ]),
      },
      contactPerson: { findMany: jest.fn().mockResolvedValue([]) },
      party: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([{ fullName: 'Lina Haddad' }]) },
    },
  };
  const entitlements = { assertFeature: jest.fn(), assertAiQuota: jest.fn() };
  const access = new AiAccess(
    providers,
    prisma as unknown as PrismaService,
    entitlements as unknown as EntitlementsService,
  );
  const cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
  const usage = { record: jest.fn(), cost: jest.fn(() => new Decimal(0)) };
  const cls = { get: jest.fn((key: string) => (key === 'officeId' ? OFFICE : undefined)) };
  const executor = new AiExecutor(
    access,
    providers,
    cache as unknown as AiCache,
    usage as unknown as AiUsageRecorder,
    config,
    cls as unknown as ClsService<RequestContext>,
    new PiiRedactor(),
  );
  const researcher = new LegalResearcher(
    executor,
    { register: jest.fn() } as unknown as AiJobRegistry,
    cache as unknown as AiCache,
    prisma as unknown as PrismaService,
    config,
    cls as unknown as ClsService<RequestContext>,
  );
  const jobs = {
    // Like AiJobs: `onCreate` runs in the job row's transaction.
    enqueue: jest.fn(async (job: { onCreate?: (tx: unknown, id: string) => Promise<void> }) => {
      await job.onCreate?.({}, JOB);
      return { jobId: JOB, status: 'QUEUED' };
    }),
    get: jest.fn(),
  };
  const audit = { log: jest.fn() };
  const service = new LegalResearchService(
    access,
    jobs as unknown as AiJobs,
    cache as unknown as AiCache,
    audit as unknown as AuditService,
    prisma as unknown as PrismaService,
    cls as unknown as ClsService<RequestContext>,
    new PiiRedactor(),
  );
  return { researcher, service, fake: providers.fake, cache, usage, jobs, audit, prisma, cls };
}

const fields = { question: QUESTION, language: 'EN', jurisdiction: 'PALESTINE' } as const;
const hash = researchHash(fields, LEGAL_RESEARCH_V1.version);
const context = { aiJobId: JOB, userId: 'u1', signal: new AbortController().signal };

describe('LegalResearcher (D-256)', () => {
  it('sends no PII, searches the official sources first, re-hydrates the answer and cites the search', async () => {
    const { researcher, fake, cache } = setup();
    fake.script({
      json: { answer: 'Thirty days; [PARTY_1] should act now.', jurisdictionNote: null },
      sources: [SOURCE],
    });
    await expect(researcher.run({ ...fields, hash }, context)).resolves.toEqual({ citations: 1 });

    const sent = fake.requests[0];
    const outgoing = JSON.stringify(sent);
    for (const pii of [CLIENT, 'Odeh', PHONE, EMAIL, 'Lina Haddad'])
      expect(outgoing).not.toContain(pii);
    expect(sent?.webSearch).toEqual({ domains: LEGAL_SOURCES.PALESTINE });
    expect(fake.requests).toHaveLength(1);
    const research = expect.objectContaining({
      answer: `Thirty days; ${CLIENT} should act now.`,
      citations: [SOURCE],
      unsourced: false,
      jurisdiction: 'PALESTINE',
      promptVersion: 'legal-research.v1',
    });
    expect(cache.set).toHaveBeenCalledWith(OFFICE, researchKeys.job(JOB), research, 86_400);
    expect(cache.set).toHaveBeenCalledWith(OFFICE, researchKeys.question(hash), research, 86_400);
  });

  it('falls back to the open web once when the official sources found nothing, counted once', async () => {
    const { researcher, fake, cache, usage } = setup();
    fake.script({ json: { answer: 'Not found.', jurisdictionNote: null }, sources: [] });
    fake.script({
      json: { answer: 'Thirty days.', jurisdictionNote: 'Check amendments.' },
      sources: [SOURCE],
    });
    await researcher.run({ ...fields, hash }, context);
    expect(fake.requests.map((r) => r.webSearch)).toEqual([
      { domains: LEGAL_SOURCES.PALESTINE },
      { domains: [] },
    ]);
    expect(usage.record.mock.calls.map(([row]: [{ partial: boolean }]) => row.partial)).toEqual([
      false,
      true,
    ]);
    expect(cache.set).toHaveBeenCalledWith(
      OFFICE,
      researchKeys.job(JOB),
      expect.objectContaining({ answer: 'Thirty days.', jurisdictionNote: 'Check amendments.' }),
      86_400,
    );
  });

  it('labels an answer without any source as unsourced', async () => {
    const { researcher, fake, cache } = setup();
    fake.script({ json: { answer: 'Unclear.', jurisdictionNote: null } });
    fake.script({ json: { answer: 'Unclear.', jurisdictionNote: null } });
    await expect(researcher.run({ ...fields, hash }, context)).resolves.toEqual({ citations: 0 });
    expect(cache.set).toHaveBeenCalledWith(
      OFFICE,
      researchKeys.job(JOB),
      expect.objectContaining({ citations: [], unsourced: true }),
      86_400,
    );
  });

  it("hides a client named by part of the name, looked up by the question's words", async () => {
    const { researcher, fake, prisma } = setup();
    fake.script({ json: { answer: 'Yes.', jurisdictionNote: null }, sources: [SOURCE] });
    const partial = {
      question: 'Can Mr Odeh still appeal the ruling?',
      language: 'EN',
      jurisdiction: 'PALESTINE',
    } as const;
    await researcher.run(
      { ...partial, hash: researchHash(partial, LEGAL_RESEARCH_V1.version) },
      context,
    );
    expect(fake.requests[0]?.user).not.toContain('Odeh');
    const [{ where }] = prisma.db.client.findMany.mock.calls[0] as [{ where: { OR: object[] } }];
    expect(where.OR).toContainEqual({ fullName: { contains: 'odeh', mode: 'insensitive' } });
  });

  it('searches the open web once for a jurisdiction without official sources', async () => {
    const { researcher, fake, cache } = setup();
    fake.script({
      json: { answer: 'Yes.', jurisdictionNote: null },
      sources: [{ url: SOURCE.url, title: SOURCE.title }],
    });
    const other = { ...fields, jurisdiction: 'OTHER' } as const;
    await researcher.run(
      { ...other, hash: researchHash(other, LEGAL_RESEARCH_V1.version) },
      context,
    );
    expect(fake.requests.map((r) => r.webSearch)).toEqual([{ domains: [] }]);
    expect(cache.set).toHaveBeenCalledWith(
      OFFICE,
      researchKeys.job(JOB),
      expect.objectContaining({
        citations: [{ url: SOURCE.url, title: SOURCE.title, date: null }],
      }),
      86_400,
    );
  });
});

describe('LegalResearchService (D-256)', () => {
  it('refuses with AI-001 while the platform has research switched off, before anything is queued', async () => {
    const { service, jobs } = setup('none');
    await expect(service.request({ question: QUESTION, language: 'EN' })).rejects.toMatchObject({
      code: 'AI-001',
    });
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it("queues a job for the office's jurisdiction and audits the redacted question", async () => {
    const { service, jobs, audit } = setup();
    await expect(service.request({ question: QUESTION, language: 'EN' })).resolves.toEqual({
      status: 202,
      accepted: { jobId: JOB, status: 'QUEUED' },
    });
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: LEGAL_RESEARCH_JOB,
        research: true,
        fields: { ...fields, hash },
        dedupeKey: `research:${hash}`,
      }),
    );
    const [, entry] = audit.log.mock.calls[0] as [unknown, { newValues: { question: string } }];
    expect(entry).toMatchObject({ entityType: 'LegalResearch', entityId: JOB, action: 'CREATE' });
    for (const pii of [CLIENT, PHONE, EMAIL]) expect(entry.newValues.question).not.toContain(pii);
  });

  it('answers 200 from the cache when the same question was answered recently', async () => {
    const { service, cache, jobs } = setup();
    const stored = {
      answer: 'Thirty days.',
      citations: [SOURCE],
      jurisdictionNote: null,
      unsourced: false,
      jurisdiction: 'PALESTINE',
      language: 'EN',
      provider: 'fake',
      model: 'fake-1',
      promptVersion: 'legal-research.v1',
      createdAt: new Date().toISOString(),
    };
    cache.get.mockResolvedValueOnce(stored);
    await expect(service.request({ question: QUESTION, language: 'EN' })).resolves.toEqual({
      status: 200,
      research: stored,
    });
    expect(cache.get).toHaveBeenCalledWith(OFFICE, researchKeys.question(hash));
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it("returns a job's answer only through the caller's own job, else 404", async () => {
    const { service, jobs } = setup();
    jobs.get.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 'RES-001' }));
    await expect(service.get(JOB)).rejects.toMatchObject({ code: 'RES-001' });
    jobs.get.mockResolvedValueOnce({});
    await expect(service.get(JOB)).rejects.toMatchObject({ code: 'RES-001' });
  });

  it("returns the kept answer of the caller's own job", async () => {
    const { service, cache } = setup();
    cache.get.mockResolvedValueOnce(STORED);
    await expect(service.get(JOB)).resolves.toEqual(STORED);
    expect(cache.get).toHaveBeenCalledWith(OFFICE, researchKeys.job(JOB));
  });

  it('uses the asked jurisdiction without reading the office', async () => {
    const { service, jobs, prisma } = setup();
    await service.request({ question: QUESTION, language: 'EN', jurisdiction: 'JORDAN' });
    expect(prisma.db.office.findFirstOrThrow).not.toHaveBeenCalled();
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ fields: expect.objectContaining({ jurisdiction: 'JORDAN' }) }),
    );
  });

  it('refuses outside an office context', async () => {
    const { service, cls, jobs } = setup();
    cls.get.mockReturnValue(undefined);
    await expect(service.request({ question: QUESTION, language: 'EN' })).rejects.toThrow(
      'No office',
    );
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
});

const STORED = {
  answer: 'Thirty days.',
  citations: [SOURCE],
  jurisdictionNote: null,
  unsourced: false,
  jurisdiction: 'PALESTINE',
  language: 'EN',
  provider: 'fake',
  model: 'fake-1',
  promptVersion: 'legal-research.v1',
  createdAt: '2026-11-28T00:00:00.000Z',
};
