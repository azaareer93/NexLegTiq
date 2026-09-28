# AI & OCR

> Source: "AI Features Implementation Guide", Backend Deep Dive, Flow Charts 1–3, Performance. Resolutions: D-014, D-057.

## OCR pipeline (MVP)
Upload (`POST /documents`, streamed to object storage, ≤ 50 MB, allow-listed MIME sniffed from bytes not extension)
→ `Document(status=SCANNING)` → ClamAV scan (fail closed → QUARANTINED + `STO-004`) → enqueue `ocr:process-document`
→ 202. Worker (`runInTenant`):
1. DOCX/XLSX/CSV → text extraction (mammoth / sheetjs), `ocrStatus=NOT_NEEDED`.
2. PDF with text layer (≥ 50 chars/page avg) → `pdfjs` text; else rasterize pages.
3. Images/scans → **Tesseract (`ara+eng`)**, keep per-page confidence. If mean confidence < 70 or Arabic handwriting suspected and
   office plan allows → **Google Cloud Vision** `DOCUMENT_TEXT_DETECTION` fallback. (Textract: Phase 2 for tables/forms.)
4. Normalize Arabic (tashkeel/tatweel strip, alef/ya normalization) for the search vector only; store original text.
5. Save `DocumentText` (+ tsvectors), `Document.status=READY`, timeline `DOCUMENT_UPLOADED`, WS `document.processed`.
6. Auto-summary: if office `enableAI` and doc type ∈ {PLEADING, EVIDENCE, JUDGMENT, COURT_ORDER} and > 500 words and quota left →
   enqueue `ai:summarize-document`.
Budgets: < 30 s for ≤ 10 pages; timeouts → FAILED with retry button.

## AI module (MVP features)
| Feature | Trigger | Output schema |
|---|---|---|
| Document summary (P0) | manual button or auto (above) | `DocumentSummarySchema { summary (50–1500 chars), keyFacts[≤10], keyLegalIssues[≤5], parties[]?, dates[]? }` |
| Session summary + next steps (P0) | `POST sessions/:id/outcome` with minutes > 100 words, or manual | `SessionSummarySchema { summary, keyFacts[], nextSteps[{action, dueInDays?}], riskAssessment: LOW|MEDIUM|HIGH }` |
| Witness statement summary (P1-in-MVP) | manual | same as document summary |
"Create tasks from next steps" creates Task rows with `sourceType=AI_NEXT_STEP` after the user confirms (never silently).

Architecture (`modules/ai`):
- `AiProvider` interface → `OpenAiProvider` (primary), `GeminiProvider` (fallback), `AnthropicProvider` (optional, config switch).
  Provider chosen by `AI_PRIMARY_PROVIDER` / `AI_FALLBACK_PROVIDER`; fallback on 5xx/timeouts/rate limit, not on validation errors.
- `BaseAiService.execute({feature, cacheKey, prompt, schema, ttl})`: quota check → cache → **PII redact** → provider call
  (JSON mode, temperature 0.2, max tokens from config) → parse → Zod validate (1 repair retry) → **re-hydrate PII** →
  store AiSummary + AiUsage → cache → WS notify.
- `PromptBuilder` with versioned prompts in `modules/ai/prompts/*.v1.ts` (`promptVersion` stored with every output).
  System prompt: legal assistant for MENA law offices; accurate, structured, neutral; **not legal advice**; answer in requested
  language (MSA for Arabic); never invent citations; say "not stated in the document" when unsure.
- Input handling: chunk long documents (map-reduce summarize) instead of blind truncation; cap input tokens per plan.
- `PiiRedactor` (D-057): replaces names of the file's clients/parties/witnesses, emails, phones, national IDs, IBANs with
  stable placeholders (`[PARTY_1]`), mapping kept in memory for the job only.
- `CostTracker`: AiUsage rows; daily platform alert if > `AI_COST_ALERT_THRESHOLD_USD` (default 20 for MVP); office quota
  from plan (`aiQuotaMonthly`), returns `AUTH-103` when exceeded.
- Cache keys: `o:{officeId}:ai:summary:{documentId}:{versionNumber}:{lang}:{promptVersion}` (24h+; invalidated by new version).
- Config (Zod env): `AI_PRIMARY_PROVIDER`, `AI_FALLBACK_PROVIDER`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `GEMINI_API_KEY`, `GEMINI_MODEL`,
  `ANTHROPIC_API_KEY?`, `AI_MAX_OUTPUT_TOKENS=4096`, `AI_TEMPERATURE=0.2`, `AI_CACHE_TTL=86400`, `AI_COST_ALERT_THRESHOLD_USD`.
  Model names are config, never hard-coded.

## Quality, ethics, UX
- Every AI output rendered with a disclaimer component (`<AiDisclaimer kind="summary" />`) — texts in i18n, from Notion `AI_DISCLAIMERS`.
- Show provider/model/generated-at, allow regenerate, allow "report issue" (stores feedback).
- Human-in-the-loop: AI never changes case data by itself.
- Evaluation set: 20 anonymized Arabic + English documents in `apps/backend-api/test/ai-evals/` with reference summaries;
  script reports ROUGE-L (target > 0.6 EN) and a checklist for hallucinated citations; run before changing prompts/models.
- Offices can disable AI (`enableAI=false`) → endpoints return `AI-005`, UI hides AI entry points.

## Phase 2+ (not MVP)
Contract analysis vs jurisdiction (risk score, missing/risky clauses, recommendations), evidence suggestions, similar cases via
pgvector (text-embedding-3-small 1536), case Q&A with RAG, drafting from templates, voice transcription (Google STT), email ingestion,
hallucination/bias detectors.
