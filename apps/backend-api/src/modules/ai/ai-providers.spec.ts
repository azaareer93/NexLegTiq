import type { PinoLogger } from 'nestjs-pino';

import { AiProviders } from './ai-providers';
import { CircuitBreaker } from './circuit-breaker';
import type { AiRequest } from './providers/ai-provider';
import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';

const logger = { setContext: jest.fn(), warn: jest.fn() } as unknown as PinoLogger;

function providers(env: Record<string, string> = {}): AiProviders {
  return new AiProviders(
    new AppConfig(
      parseEnv(
        testEnv({
          AI_PRIMARY_PROVIDER: 'openai',
          OPENAI_API_KEY: 'sk-test',
          OPENAI_MODEL: 'gpt-test',
          AI_FALLBACK_PROVIDER: 'gemini',
          GEMINI_API_KEY: 'gm-test',
          GEMINI_MODEL: 'gemini-test',
          AI_TIMEOUT_MS: '1000',
          ...env,
        }),
      ),
    ),
    logger,
  );
}

const request: AiRequest = {
  feature: 'test',
  system: 'system',
  user: 'user',
  jsonSchema: { type: 'object' },
  maxOutputTokens: 512,
  temperature: 0.2,
  signal: new AbortController().signal,
};

const openAiOk = {
  model: 'gpt-test-2026',
  choices: [{ message: { content: '{"from":"openai"}' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};
const geminiOk = {
  candidates: [{ content: { parts: [{ text: '{"from":' }, { text: '"gemini"}' }] } }],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 6 },
};

type Reply = number | { status: number; body: unknown } | 'hang' | 'network';

/** Answers fetch per provider from a script; `'hang'` waits for the abort (timeout). */
function scriptFetch(replies: { openai?: Reply[]; gemini?: Reply[] }) {
  const calls: { url: string; init: RequestInit }[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation((input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const reply = (url.includes('openai') ? replies.openai : replies.gemini)?.shift() ?? 500;
    if (reply === 'network') return Promise.reject(new TypeError('fetch failed'));
    if (reply === 'hang') {
      return new Promise((_resolve, reject) =>
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        ),
      );
    }
    const { status, body } =
      typeof reply === 'number' ? { status: reply, body: { error: { message: 'x' } } } : reply;
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  });
  return calls;
}

describe('AiProviders (fallback matrix, D-130)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('should answer from the primary and send OpenAI JSON mode without retention', async () => {
    const calls = scriptFetch({ openai: [{ status: 200, body: openAiOk }] });
    await expect(providers().complete(request)).resolves.toEqual({
      provider: 'openai',
      text: '{"from":"openai"}',
      model: 'gpt-test-2026',
      priceModel: 'gpt-test',
      inputTokens: 10,
      outputTokens: 5,
    });
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'gpt-test',
      response_format: { type: 'json_object' },
      store: false,
    });
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer sk-test',
    );
  });

  it.each([
    ['a 5xx', 503],
    ['a 429', 429],
    ['a network failure', 'network' as const],
    ['a 200 that is not JSON', { status: 200, body: 'not json' }],
  ])('should fall back to Gemini on %s', async (_label, reply) => {
    const calls = scriptFetch({
      openai: [reply as Reply],
      gemini: [{ status: 200, body: geminiOk }],
    });
    await expect(providers().complete(request)).resolves.toMatchObject({
      provider: 'gemini',
      text: '{"from":"gemini"}',
      model: 'gemini-test',
      inputTokens: 12,
      outputTokens: 6,
    });
    expect(calls[1]?.url).toContain('models/gemini-test:generateContent');
    expect((calls[1]?.init.headers as Record<string, string>)['x-goog-api-key']).toBe('gm-test');
  });

  it('should fall back when the primary times out', async () => {
    scriptFetch({ openai: ['hang'], gemini: [{ status: 200, body: geminiOk }] });
    await expect(providers().complete(request)).resolves.toMatchObject({ provider: 'gemini' });
  });

  it('should not fall back on a refused request: AI-003 when too large, else AI-001', async () => {
    const tooLarge = { status: 400, body: { error: { code: 'context_length_exceeded' } } };
    const calls = scriptFetch({ openai: [tooLarge, 401] });
    const chain = providers();
    await expect(chain.complete(request)).rejects.toMatchObject({ code: 'AI-003' });
    await expect(chain.complete(request)).rejects.toMatchObject({ code: 'AI-001' });
    expect(calls.every((call) => call.url.includes('openai'))).toBe(true);
  });

  it('should answer AI-002 when the last provider was rate limited, AI-001 otherwise', async () => {
    scriptFetch({ openai: [500, 500], gemini: [429, 502] });
    const chain = providers();
    await expect(chain.complete(request)).rejects.toMatchObject({ code: 'AI-002' });
    await expect(chain.complete(request)).rejects.toMatchObject({ code: 'AI-001' });
  });

  it('should skip a provider whose circuit is open', async () => {
    const calls = scriptFetch({
      openai: [500, 500, 500, 500, 500],
      gemini: Array.from({ length: 6 }, () => ({ status: 200, body: geminiOk })),
    });
    const chain = providers();
    for (let i = 0; i < 6; i += 1) await chain.complete(request);
    expect(calls.filter((call) => call.url.includes('openai'))).toHaveLength(5);
  });

  it('should pass the caller abort through instead of falling back', async () => {
    scriptFetch({ openai: ['hang'] });
    const controller = new AbortController();
    const pending = providers().complete({ ...request, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
  });

  it('should answer AI-001 without a provider, and report whether text leaves the platform', async () => {
    const none = providers({ AI_PRIMARY_PROVIDER: 'none', AI_FALLBACK_PROVIDER: 'none' });
    expect(none.configured).toBe(false);
    await expect(none.complete(request)).rejects.toMatchObject({ code: 'AI-001' });
    expect(providers().sendsOut).toBe(true);
    const fake = providers({
      NODE_ENV: 'test',
      AI_PRIMARY_PROVIDER: 'fake',
      AI_FALLBACK_PROVIDER: 'none',
    });
    expect(fake.sendsOut).toBe(false);
    await expect(fake.complete({ ...request, user: 'same' })).resolves.toEqual(
      await fake.complete({ ...request, user: 'same' }),
    );
  });
});

describe('CircuitBreaker', () => {
  it('should open after the threshold, let one trial through after the cool-down, and close on success', () => {
    let now = 0;
    const breaker = new CircuitBreaker(2, 1000, () => now);
    breaker.failed();
    expect(breaker.allow()).toBe(true);
    breaker.failed();
    expect(breaker.allow()).toBe(false);
    now = 1000;
    expect(breaker.allow()).toBe(true);
    expect(breaker.allow()).toBe(false);
    breaker.failed();
    now = 1500;
    expect(breaker.allow()).toBe(false);
    now = 2000;
    expect(breaker.allow()).toBe(true);
    breaker.succeeded();
    expect(breaker.allow()).toBe(true);
    expect(breaker.allow()).toBe(true);
  });
});

describe('AiProviders (refusals and blocks)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('should treat a safety block or refusal as final: no fallback, the breaker untouched', async () => {
    const blocked = {
      status: 200,
      body: { promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: {} },
    };
    const filtered = {
      status: 200,
      body: {
        ...openAiOk,
        choices: [{ message: { content: null }, finish_reason: 'content_filter' }],
      },
    };
    const calls = scriptFetch({
      gemini: [blocked, blocked, blocked, blocked, blocked, blocked],
      openai: [filtered],
    });
    const geminiFirst = providers({
      AI_PRIMARY_PROVIDER: 'gemini',
      AI_FALLBACK_PROVIDER: 'openai',
    });
    for (let i = 0; i < 6; i += 1) {
      await expect(geminiFirst.complete(request)).rejects.toMatchObject({ code: 'AI-001' });
    }
    expect(calls.every((call) => call.url.includes('generativelanguage'))).toBe(true);
    await expect(providers().complete(request)).rejects.toMatchObject({ code: 'AI-001' });
  });

  it('should count Gemini thinking tokens as output and send the schema without $schema', async () => {
    const thinking = {
      ...geminiOk,
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, thoughtsTokenCount: 5 },
    };
    const calls = scriptFetch({ gemini: [{ status: 200, body: thinking }] });
    const geminiOnly = providers({ AI_PRIMARY_PROVIDER: 'gemini', AI_FALLBACK_PROVIDER: 'none' });
    await expect(
      geminiOnly.complete({
        ...request,
        jsonSchema: { $schema: 'x', type: 'object' },
        followUp: 'again',
      }),
    ).resolves.toMatchObject({ outputTokens: 9, priceModel: 'gemini-test' });
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      generationConfig: { responseJsonSchema: Record<string, unknown> };
      contents: { parts: { text: string }[] }[];
    };
    expect(body.generationConfig.responseJsonSchema).toEqual({ type: 'object' });
    expect(body.contents[0]?.parts.map((part) => part.text)).toEqual(['user', 'again']);
  });
});

describe('CircuitBreaker release', () => {
  it('should free the half-open trial when it ends without a verdict', () => {
    let now = 0;
    const breaker = new CircuitBreaker(1, 1000, () => now);
    breaker.failed();
    now = 1000;
    expect(breaker.allow()).toBe(true);
    expect(breaker.allow()).toBe(false);
    breaker.release();
    expect(breaker.allow()).toBe(true);
  });
});
