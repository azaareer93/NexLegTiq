import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';

import type { AiAccess } from './ai-access';
import type { AiCache } from './ai-cache';
import { AiExecutor, BaseAiService, MAX_INPUT_CHARS } from './ai-executor';
import type { AiPrompt, ExecuteOptions } from './ai-executor';
import { AiProviders } from './ai-providers';
import { AiUsageRecorder } from './ai-usage';
import { PassThroughRedactor } from './redaction';
import type { AiRedactor } from './redaction';
import type { RequestContext } from '../../common/context/request-context';
import { AppException } from '../../common/errors/app.exception';
import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';

const OFFICE = '01900000-0000-7000-8000-0000000000aa';
const Summary = z.object({ summary: z.string().min(1).max(200), parties: z.array(z.string()) });

/** Replaces every listed name with [PARTY_n] and back — the shape the real redactor (D-057) will have. */
const nameRedactor: AiRedactor = {
  redactsPii: true,
  redact(text, { names }) {
    let redacted = text;
    names.forEach((name, index) => (redacted = redacted.split(name).join(`[PARTY_${index + 1}]`)));
    return {
      text: redacted,
      restore: (value) =>
        names.reduce((out, name, index) => out.split(`[PARTY_${index + 1}]`).join(name), value),
    };
  },
};

function setup({
  env = {} as Record<string, string>,
  redactor = nameRedactor as AiRedactor,
  cached = null as unknown,
  denied = null as AppException | null,
  quotaDenied = null as AppException | null,
} = {}) {
  const config = new AppConfig(
    parseEnv(testEnv({ NODE_ENV: 'test', AI_PRIMARY_PROVIDER: 'fake', ...env })),
  );
  const providers = new AiProviders(config, {
    setContext: jest.fn(),
    warn: jest.fn(),
  } as unknown as PinoLogger);
  const access = {
    assertEnabled: jest.fn(() => (denied ? Promise.reject(denied) : Promise.resolve())),
    assertQuota: jest.fn(() => (quotaDenied ? Promise.reject(quotaDenied) : Promise.resolve())),
  };
  const cache = { get: jest.fn().mockResolvedValue(cached), set: jest.fn() };
  const usage = {
    record: jest.fn(),
    cost: (model: string, input: number, output: number) =>
      new AiUsageRecorder({} as never, config, {} as never).cost(model, input, output),
  };
  const cls = { get: jest.fn((key: string) => (key === 'officeId' ? OFFICE : undefined)) };
  const executor = new AiExecutor(
    access as unknown as AiAccess,
    providers,
    cache as unknown as AiCache,
    usage as unknown as AiUsageRecorder,
    config,
    cls as unknown as ClsService<RequestContext>,
    redactor,
  );
  return { executor, fake: providers.fake, access, cache, usage, cls };
}

const prompt: AiPrompt = {
  version: 'summary.v1',
  system: 'Summarise.',
  user: 'Ahmad Saleh sued محمد علي over the lease.',
};
const options = (overrides: Partial<ExecuteOptions<z.infer<typeof Summary>>> = {}) => ({
  feature: 'test-summary',
  prompt,
  schema: Summary,
  redactionContext: { names: ['Ahmad Saleh', 'محمد علي'] },
  cacheKey: ['summary', 'doc-1'],
  userId: 'user-1',
  ...overrides,
});

describe('AiExecutor (D-130)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('should redact before the call, re-hydrate the answer, record usage and cache it', async () => {
    const { executor, fake, usage, cache } = setup();
    fake.script({
      json: { summary: '[PARTY_1] sued [PARTY_2].', parties: ['[PARTY_1]', '[PARTY_2]'] },
    });
    const result = await executor.execute(options());
    expect(fake.requests[0]?.user).toBe('[PARTY_1] sued [PARTY_2] over the lease.');
    expect(fake.requests[0]?.jsonSchema).toMatchObject({ type: 'object' });
    expect(result).toEqual({
      value: { summary: 'Ahmad Saleh sued محمد علي.', parties: ['Ahmad Saleh', 'محمد علي'] },
      provider: 'fake',
      model: 'fake-1',
      promptVersion: 'summary.v1',
      cached: false,
    });
    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'test-summary',
        provider: 'fake',
        cached: false,
        userId: 'user-1',
      }),
    );
    expect(cache.set).toHaveBeenCalledWith(
      OFFICE,
      ['test-summary', 'summary', 'doc-1', 'summary.v1'],
      expect.objectContaining({ promptVersion: 'summary.v1' }),
      86_400,
    );
  });

  it('should serve a valid cached answer without a call, recorded as a free use', async () => {
    const hit = {
      value: { summary: 'cached', parties: [] },
      provider: 'fake',
      model: 'fake-1',
      promptVersion: 'summary.v1',
    };
    const { executor, fake, usage } = setup({ cached: hit });
    await expect(executor.execute(options())).resolves.toEqual({ ...hit, cached: true });
    expect(fake.requests).toHaveLength(0);
    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({ cached: true, inputTokens: 0, outputTokens: 0 }),
    );
  });

  it('should ignore a cached answer the schema no longer accepts, and skip the cache without a key', async () => {
    const { executor, fake, cache } = setup({ cached: { value: { wrong: true } } });
    fake.script({ json: { summary: 's', parties: [] } }, { json: { summary: 's', parties: [] } });
    await expect(executor.execute(options())).resolves.toMatchObject({ cached: false });
    await executor.execute(options({ cacheKey: undefined }));
    expect(fake.requests).toHaveLength(2);
    expect(cache.get).toHaveBeenCalledTimes(1);
  });

  it('should repair an invalid answer once, counting the tokens of both calls', async () => {
    const { executor, fake, usage } = setup();
    fake.script({ text: 'not json' }, { json: { summary: 'fixed', parties: [] } });
    await expect(executor.execute(options())).resolves.toMatchObject({
      value: { summary: 'fixed' },
    });
    expect(fake.requests[1]?.followUp).toContain('Your previous answer was not valid (not JSON)');
    const recorded = usage.record.mock.calls[0]?.[0] as { inputTokens: number };
    expect(recorded.inputTokens).toBeGreaterThan(20);
  });

  it('should answer AI-004 when the repaired answer is still invalid, after recording the usage', async () => {
    const { executor, fake, usage, cache } = setup();
    fake.script({ json: { summary: '' } }, { json: { parties: 'x' } });
    await expect(executor.execute(options())).rejects.toMatchObject({ code: 'AI-004' });
    expect(fake.requests[1]?.followUp).toMatch(/summary: too_small|parties: invalid_type/);
    expect(usage.record).toHaveBeenCalledTimes(1);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('should refuse a provider that sends text out while no real redactor is installed (D-057)', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch');
    const { executor } = setup({
      redactor: new PassThroughRedactor(),
      env: { AI_PRIMARY_PROVIDER: 'openai', OPENAI_API_KEY: 'sk', OPENAI_MODEL: 'm' },
    });
    await expect(executor.execute(options())).rejects.toMatchObject({ code: 'AI-001' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should let the fake provider run with the pass-through redactor', async () => {
    const { executor, fake } = setup({ redactor: new PassThroughRedactor() });
    fake.define('test-summary', () => ({ summary: 'fixture', parties: [] }));
    await expect(executor.execute(options())).resolves.toMatchObject({
      value: { summary: 'fixture' },
    });
    expect(fake.requests[0]?.user).toBe(prompt.user);
  });

  it('should refuse an input too large (AI-003) and a caller without access, before any call', async () => {
    const { executor, fake } = setup();
    const big = { ...prompt, user: 'x'.repeat(MAX_INPUT_CHARS + 1) };
    await expect(executor.execute(options({ prompt: big }))).rejects.toMatchObject({
      code: 'AI-003',
    });
    const denied = setup({ denied: new AppException('AUTH-103', 'quota') });
    await expect(denied.executor.execute(options())).rejects.toMatchObject({ code: 'AUTH-103' });
    expect([...fake.requests, ...denied.fake.requests]).toHaveLength(0);
  });

  it('should fail loudly without an office in the context', async () => {
    const { executor, cls } = setup();
    cls.get.mockReturnValue(undefined);
    await expect(executor.execute(options())).rejects.toThrow('No office in the context');
  });

  it('should be reachable from a feature service through BaseAiService', async () => {
    class Feature extends BaseAiService {
      run() {
        return this.execute(options());
      }
    }
    const { executor, fake } = setup();
    fake.script({ json: { summary: 'from feature', parties: [] } });
    await expect(new Feature(executor).run()).resolves.toMatchObject({
      value: { summary: 'from feature' },
    });
  });

  it('should serve a cache hit even when the quota is used up, but check the quota before a call', async () => {
    const hit = {
      value: { summary: 'cached', parties: [] },
      provider: 'fake',
      model: 'fake-1',
      promptVersion: 'summary.v1',
    };
    const cachedSetup = setup({ cached: hit, quotaDenied: new AppException('AUTH-103', 'quota') });
    await expect(cachedSetup.executor.execute(options())).resolves.toMatchObject({ cached: true });
    const missSetup = setup({ quotaDenied: new AppException('AUTH-103', 'quota') });
    await expect(missSetup.executor.execute(options())).rejects.toMatchObject({ code: 'AUTH-103' });
    expect(missSetup.fake.requests).toHaveLength(0);
  });

  it('should record the paid first answer when the repair call fails', async () => {
    const { executor, fake, usage } = setup();
    fake.script({ text: 'not json' }, { error: new AppException('AI-002', 'rate limited') });
    await expect(executor.execute(options())).rejects.toMatchObject({ code: 'AI-002' });
    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({ cached: false, provider: 'fake' }),
    );
    expect(fake.requests[1]?.followUp).toContain('not valid (not JSON)');
    expect(fake.requests[1]?.user).toBe(fake.requests[0]?.user);
  });

  it('should price each call at its configured model and redact the system prompt too', async () => {
    const { executor, fake, usage } = setup({
      env: { AI_MODEL_PRICES: '{"fake-1":{"input":1,"output":1}}' },
    });
    fake.script({ json: { summary: 's', parties: [] } });
    await executor.execute(
      options({ prompt: { ...prompt, system: 'About Ahmad Saleh.' }, cacheKey: undefined }),
    );
    expect(fake.requests[0]?.system).toBe('About [PARTY_1].');
    const entry = usage.record.mock.calls[0]?.[0] as {
      costUsd: string;
      inputTokens: number;
      outputTokens: number;
    };
    expect(Number(entry.costUsd)).toBeCloseTo(
      (entry.inputTokens + entry.outputTokens) / 1_000_000,
      6,
    );
  });

  it('should answer AI-001 when the providers miss the deadline, and pass a caller abort through', async () => {
    const { executor, fake } = setup();
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
    jest.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(AbortSignal.abort());
    fake.script({ error: aborted });
    await expect(executor.execute(options())).rejects.toMatchObject({ code: 'AI-001' });
    const caller = new AbortController();
    caller.abort();
    fake.script({ error: aborted });
    await expect(executor.execute(options({ signal: caller.signal }))).rejects.toBe(aborted);
  });
});
