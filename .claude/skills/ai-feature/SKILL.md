---
name: ai-feature
description: How to build or change an AI capability in NexLegTiq — provider abstraction with fallback, versioned prompts, PII redaction, Zod-validated JSON output, quotas and cost tracking, caching, async jobs, disclaimers, and evals. Use for any work in modules/ai or features that call an LLM or OCR provider.
---
# AI feature recipe (see docs/context/ai-ocr.md)

1. **Schema**: output Zod schema in `packages/shared-contracts/src/ai.contract.ts` (bounded lengths/array sizes).
2. **Prompt**: `apps/backend-api/src/modules/ai/prompts/<feature>.v<N>.ts` exporting `{ version, system, buildUser(input) }`.
   System prompt includes: MENA legal assistant, not legal advice, respond in `{language}` (MSA for Arabic), JSON only matching the schema,
   no invented citations, "not stated" when unknown. Bump version on any change; never edit a released version in place.
3. **Service**: extend `BaseAiService`; call `this.execute({ feature, cacheKey, prompt, schema, ttl, redactionContext })`.
   `redactionContext` lists names from the file (clients, parties, witnesses) for the `PiiRedactor`.
4. **Async**: controller enqueues `ai:<job>` and returns 202 `{ jobId }`; worker runs in tenant; result persisted (AiSummary + AiUsage);
   WS `ai.job.completed`. Check `office.settings.enableAI` and plan quota before enqueueing (`AI-005`, `AUTH-103`).
5. **Providers**: never import SDKs outside `modules/ai/providers`; models from config; fallback only on availability errors.
6. **Tests**: unit with a fake provider (deterministic JSON), redaction round-trip tests (Arabic + English names), schema-invalid output → one
   repair attempt then `AI-004`; integration with MSW mocking provider HTTP; never call real providers in CI.
7. **Evals**: run `pnpm nx run backend-api:ai-evals --feature <x>` on prompt/model changes; paste summary in PR.
8. **UI**: `<AiDisclaimer kind>` + model/time metadata + regenerate + report; suggestions require explicit user confirmation.
