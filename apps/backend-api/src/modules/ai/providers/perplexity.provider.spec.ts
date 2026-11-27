import { ProviderUnavailableError } from './ai-provider';
import type { AiRequest } from './ai-provider';
import { PerplexityProvider } from './perplexity.provider';

const request = (overrides: Partial<AiRequest> = {}): AiRequest => ({
  feature: 'legal-research',
  system: 'Answer.',
  user: 'What is the limitation period for a civil claim?',
  jsonSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' },
  maxOutputTokens: 1000,
  temperature: 0.2,
  signal: new AbortController().signal,
  webSearch: { domains: ['muqtafi.birzeit.edu'] },
  ...overrides,
});

const answer = {
  id: 'resp_1',
  object: 'response',
  status: 'completed',
  model: 'perplexity/sonar',
  output: [
    {
      type: 'search_results',
      queries: ['limitation period civil claim Palestine'],
      results: [
        {
          id: 1,
          url: 'https://muqtafi.birzeit.edu/law/1',
          title: 'Civil Code',
          snippet: '…',
          date: '2012-01-01',
        },
        { id: 2, url: 'https://muqtafi.birzeit.edu/law/2', title: 'Procedure', snippet: '…' },
      ],
    },
    {
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: '{"answer":"Fifteen years.","jurisdictionNote":null}',
          annotations: [
            {
              type: 'url_citation',
              url: 'https://muqtafi.birzeit.edu/law/1',
              title: 'Civil Code',
              start_index: 0,
              end_index: 5,
            },
            {
              type: 'url_citation',
              url: 'https://muqtafi.birzeit.edu/law/1',
              title: 'Civil Code',
              start_index: 6,
              end_index: 9,
            },
            {
              type: 'url_citation',
              url: 'javascript:alert(1)',
              title: 'x',
              start_index: 0,
              end_index: 1,
            },
          ],
        },
      ],
    },
  ],
  usage: {
    input_tokens: 120,
    output_tokens: 30,
    total_tokens: 150,
    cost: { total_cost: 0.0061, currency: 'USD' },
  },
};

function respond(body: unknown, status = 200) {
  return jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe('PerplexityProvider (D-256)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('asks the Agent API with the model, one filtered web search, a JSON Schema and no retention', async () => {
    const fetch = respond(answer);
    await new PerplexityProvider('pplx-key', 'perplexity/sonar', 30_000).complete(request());
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://api.perplexity.ai/v1/agent');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer pplx-key');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'perplexity/sonar',
      instructions: 'Answer.',
      input: [{ role: 'user', content: 'What is the limitation period for a civil claim?' }],
      tools: [{ type: 'web_search', filters: { search_domain_filter: ['muqtafi.birzeit.edu'] } }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', schema: { type: 'object' } },
      },
      store: false,
    });
  });

  it('searches the open web without a filter when no domains are given', async () => {
    const fetch = respond(answer);
    await new PerplexityProvider('k', 'm', 30_000).complete(
      request({ webSearch: { domains: [] } }),
    );
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as { tools: object[] };
    expect(body.tools).toEqual([{ type: 'web_search', max_results: 10 }]);
  });

  it('returns the text, the cited pages (deduplicated, web links only, dated from the search) and the cost', async () => {
    respond(answer);
    const completion = await new PerplexityProvider('k', 'm', 30_000).complete(request());
    expect(completion).toEqual({
      text: '{"answer":"Fifteen years.","jurisdictionNote":null}',
      model: 'perplexity/sonar',
      inputTokens: 120,
      outputTokens: 30,
      sources: [
        { url: 'https://muqtafi.birzeit.edu/law/1', title: 'Civil Code', date: '2012-01-01' },
      ],
      costUsd: '0.0061',
    });
  });

  it('falls back to the search results when the text cites nothing', async () => {
    const [results, message] = answer.output;
    respond({
      ...answer,
      output: [results, { ...message, content: [{ type: 'output_text', text: '{}' }] }],
    });
    const { sources } = await new PerplexityProvider('k', 'm', 30_000).complete(request());
    expect(sources?.map((source) => source.url)).toEqual([
      'https://muqtafi.birzeit.edu/law/1',
      'https://muqtafi.birzeit.edu/law/2',
    ]);
  });

  it('treats a failed or malformed response as unavailable', async () => {
    respond({ ...answer, status: 'failed' });
    await expect(
      new PerplexityProvider('k', 'm', 30_000).complete(request()),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    respond({ unexpected: true });
    await expect(
      new PerplexityProvider('k', 'm', 30_000).complete(request()),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
