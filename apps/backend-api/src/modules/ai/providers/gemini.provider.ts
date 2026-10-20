import { z } from 'zod';

import type { AiCompletion, AiProvider, AiRequest } from './ai-provider';
import { ProviderUnavailableError } from './ai-provider';
import { postJson } from './http-provider';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const ResponseSchema = z.object({
  candidates: z
    .array(z.object({ content: z.object({ parts: z.array(z.object({ text: z.string() })) }) }))
    .min(1),
  usageMetadata: z.object({
    promptTokenCount: z.number(),
    candidatesTokenCount: z.number().default(0),
  }),
  modelVersion: z.string().optional(),
});

/** Gemini `generateContent` with a JSON Schema response (ai-ocr.md: fallback provider). */
export class GeminiProvider implements AiProvider {
  readonly name = 'gemini';

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly timeoutMs: number,
  ) {}

  async complete(request: AiRequest): Promise<AiCompletion> {
    const raw = await postJson(
      this.name,
      `${BASE}/${encodeURIComponent(this.model)}:generateContent`,
      {
        // In a header, not the URL: query strings end up in proxy logs.
        headers: { 'x-goog-api-key': this.apiKey },
        body: {
          systemInstruction: { parts: [{ text: request.system }] },
          contents: [{ role: 'user', parts: [{ text: request.user }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseJsonSchema: request.jsonSchema,
            temperature: request.temperature,
            maxOutputTokens: request.maxOutputTokens,
          },
        },
        signal: request.signal,
        timeoutMs: this.timeoutMs,
      },
    );
    const parsed = ResponseSchema.safeParse(raw);
    if (!parsed.success) throw new ProviderUnavailableError(this.name, 'server-error');
    const { candidates, usageMetadata, modelVersion } = parsed.data;
    return {
      text: (candidates[0]?.content.parts ?? []).map((part) => part.text).join(''),
      model: modelVersion ?? this.model,
      inputTokens: usageMetadata.promptTokenCount,
      outputTokens: usageMetadata.candidatesTokenCount,
    };
  }
}
