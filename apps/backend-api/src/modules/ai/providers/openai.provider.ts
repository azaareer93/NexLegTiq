import { z } from 'zod';

import type { AiCompletion, AiProvider, AiRequest } from './ai-provider';
import { ProviderRequestError, ProviderUnavailableError, providerSchema } from './ai-provider';
import { postJson } from './http-provider';

const URL = 'https://api.openai.com/v1/chat/completions';

const ResponseSchema = z.object({
  model: z.string(),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable(), refusal: z.string().nullish() }),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }),
});

/** OpenAI chat completions in JSON mode (ai-ocr.md: primary provider). */
export class OpenAiProvider implements AiProvider {
  readonly name = 'openai';

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly timeoutMs: number,
  ) {}

  async complete(request: AiRequest): Promise<AiCompletion> {
    const raw = await postJson(this.name, URL, {
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: {
        model: this.model,
        messages: [
          {
            role: 'system',
            content: `${request.system}\n\nAnswer with one JSON object matching this JSON Schema:\n${JSON.stringify(providerSchema(request.jsonSchema))}`,
          },
          { role: 'user', content: request.user },
          ...(request.followUp ? [{ role: 'user', content: request.followUp }] : []),
        ],
        response_format: { type: 'json_object' },
        temperature: request.temperature,
        max_completion_tokens: request.maxOutputTokens,
        // Zero retention where the account allows it (D-057): never kept for the provider's own use.
        store: false,
      },
      signal: request.signal,
      timeoutMs: this.timeoutMs,
    });
    const parsed = ResponseSchema.safeParse(raw);
    if (!parsed.success) throw new ProviderUnavailableError(this.name, 'server-error');
    const { model, choices, usage } = parsed.data;
    const choice = choices[0];
    // A refusal or a content filter is about this input, not the provider's health.
    if (choice?.message.refusal || choice?.finish_reason === 'content_filter') {
      throw new ProviderRequestError(this.name, 200, false);
    }
    return {
      text: choice?.message.content ?? '',
      model,
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
    };
  }
}
