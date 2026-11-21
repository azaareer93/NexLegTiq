# AI evaluation reports

One file per real run of the eval harness (D-195): `<date>-<promptVersion>.md`, written by

```bash
export OPENAI_API_KEY=… OPENAI_MODEL=…            # or GEMINI_API_KEY + GEMINI_MODEL with --provider gemini
export AI_MODEL_PRICES='{"<model>":{"input":0.15,"output":0.6}}'   # optional, USD per million tokens
pnpm nx run backend-api:ai-evals --feature summary --provider openai
```

Run it locally before adding a prompt version or changing a model; never in CI. It exits 1 when a threshold fails, and
a failing report blocks the change (manual gate, PR template "AI changes").

| Check | Threshold |
| --- | --- |
| ROUGE-L, mean, English | ≥ 0.6 |
| ROUGE-L, mean, Arabic | ≥ 0.5 (provisional) |
| Schema pass rate (after one repair) | ≥ 95 % |
| Documents citing an article, law or case number not in the source | < 5 % |
| Latency p95 per document | < 10 s |

The set is `apps/backend-api/test/ai-evals/fixtures/summary/` — synthetic documents only (invented names and numbers),
never a real or anonymised client file. Changing a reference summary needs the owner's approval in the PR.
`--provider fake` answers with the references and only checks that the harness works.
