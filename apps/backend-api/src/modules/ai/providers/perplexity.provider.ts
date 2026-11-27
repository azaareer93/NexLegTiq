import { z } from 'zod';

import type { AiCompletion, AiProvider, AiRequest, AiSource } from './ai-provider';
import { ProviderUnavailableError, providerSchema } from './ai-provider';
import { postJson } from './http-provider';

const URL = 'https://api.perplexity.ai/v1/agent';
const MAX_SOURCES = 20;
const MAX_SEARCH_RESULTS = 10;

const ResponseSchema = z.object({
  model: z.string(),
  status: z.string(),
  output: z.array(
    z.looseObject({
      type: z.string(),
      content: z
        .array(
          z.looseObject({
            type: z.string(),
            text: z.string().optional(),
            annotations: z
              .array(
                z.looseObject({
                  type: z.string(),
                  url: z.string().optional(),
                  title: z.string().nullish(),
                }),
              )
              .optional(),
          }),
        )
        .optional(),
      results: z
        .array(
          z.looseObject({
            url: z.string(),
            title: z.string().nullish(),
            date: z.string().nullish(),
          }),
        )
        .optional(),
    }),
  ),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cost: z.object({ total_cost: z.number() }).nullish(),
  }),
});
type Output = z.infer<typeof ResponseSchema>['output'];

const isWeb = (url: string): boolean => /^https?:\/\//i.test(url);

/**
 * The pages the answer cites (`url_citation` annotations), else the search results; with the date a search result gives.
 * Never the model's own JSON, so a citation cannot be invented (D-256).
 */
export function sourcesOf(output: Output): AiSource[] {
  const results = output.flatMap((item) =>
    item.type === 'search_results' ? (item.results ?? []) : [],
  );
  const dates = new Map(results.map((result) => [result.url, result.date ?? undefined]));
  const cited = output.flatMap((item) =>
    (item.content ?? []).flatMap((part) =>
      (part.annotations ?? []).flatMap((note) =>
        note.type === 'url_citation' && note.url
          ? [{ url: note.url, title: note.title ?? '' }]
          : [],
      ),
    ),
  );
  const pages =
    cited.length > 0 ? cited : results.map(({ url, title }) => ({ url, title: title ?? '' }));
  const seen = new Set<string>();
  const sources: AiSource[] = [];
  for (const page of pages) {
    if (!isWeb(page.url) || seen.has(page.url)) continue;
    seen.add(page.url);
    const date = dates.get(page.url);
    sources.push({
      url: page.url,
      title: page.title.slice(0, 300) || page.url,
      ...(date && { date }),
    });
  }
  return sources.slice(0, MAX_SOURCES);
}

/**
 * Perplexity Agent API (D-256): an explicit model with one `web_search` tool (filtered to `webSearch.domains`), a JSON
 * Schema answer and `store: false`. Used only for legal research, never in the summary chain.
 */
export class PerplexityProvider implements AiProvider {
  readonly name = 'perplexity';

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly timeoutMs: number,
  ) {}

  async complete(request: AiRequest): Promise<AiCompletion> {
    const domains = request.webSearch?.domains ?? [];
    const raw = await postJson(this.name, URL, {
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: {
        model: this.model,
        instructions: request.system,
        input: [
          { role: 'user', content: request.user },
          ...(request.followUp ? [{ role: 'user', content: request.followUp }] : []),
        ],
        tools: [
          {
            type: 'web_search',
            max_results: MAX_SEARCH_RESULTS,
            ...(domains.length > 0 && { filters: { search_domain_filter: domains } }),
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'answer', schema: providerSchema(request.jsonSchema) },
        },
        max_output_tokens: request.maxOutputTokens,
        temperature: request.temperature,
        // Zero retention (D-256): never kept for the provider's own use.
        store: false,
      },
      signal: request.signal,
      timeoutMs: this.timeoutMs,
    });
    const parsed = ResponseSchema.safeParse(raw);
    if (!parsed.success || parsed.data.status === 'failed') {
      throw new ProviderUnavailableError(this.name, 'server-error');
    }
    const { model, output, usage } = parsed.data;
    const text = output
      .flatMap((item) =>
        item.type === 'message'
          ? (item.content ?? []).map((part) =>
              part.type === 'output_text' ? (part.text ?? '') : '',
            )
          : [],
      )
      .join('');
    return {
      text,
      model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      sources: sourcesOf(output),
      ...(usage.cost && { costUsd: usage.cost.total_cost }),
    };
  }
}
