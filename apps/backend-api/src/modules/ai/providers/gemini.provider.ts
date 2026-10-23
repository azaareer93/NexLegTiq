import { z } from 'zod';

import type { AiCompletion, AiProvider, AiRequest } from './ai-provider';
import { ProviderRequestError, ProviderUnavailableError, providerSchema } from './ai-provider';
import { postJson } from './http-provider';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
/** Finish reasons that mean "blocked for this input" (safety filters), not "provider down". */
const BLOCKED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']);

const ResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({ parts: z.array(z.object({ text: z.string() })).default([]) })
          .optional(),
        finishReason: z.string().optional(),
      }),
    )
    .default([]),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  usageMetadata: z.object({
    promptTokenCount: z.number().default(0),
    candidatesTokenCount: z.number().default(0),
    // Thinking models bill their reasoning as output.
    thoughtsTokenCount: z.number().default(0),
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
          contents: [
            {
              role: 'user',
              parts: [
                { text: request.user },
                ...(request.followUp ? [{ text: request.followUp }] : []),
              ],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            responseJsonSchema: providerSchema(request.jsonSchema),
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
    return completionOf(parsed.data, this.model);
  }
}

/** The answer of a well-formed response; one blocked by the safety filters is a refusal for this input. */
function completionOf(
  { candidates, promptFeedback, usageMetadata, modelVersion }: z.infer<typeof ResponseSchema>,
  configuredModel: string,
): AiCompletion {
  const candidate = candidates[0];
  if (promptFeedback?.blockReason || !candidate || BLOCKED.has(candidate.finishReason ?? '')) {
    throw new ProviderRequestError('gemini', 200, false);
  }
  return {
    text: (candidate.content?.parts ?? []).map((part) => part.text).join(''),
    model: modelVersion ?? configuredModel,
    inputTokens: usageMetadata.promptTokenCount,
    outputTokens: usageMetadata.candidatesTokenCount + usageMetadata.thoughtsTokenCount,
  };
}
