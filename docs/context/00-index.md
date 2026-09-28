# NexLegTiq Knowledge Map

The Notion workspace is the **source of intent**; these files are the **engineering-canonical digest** (read 2026-09-28),
with every cross-document conflict resolved in `decisions.md`. Read order for a new task: this index → `decisions.md` →
the topic file(s) → the linked Notion page only if you need detail that isn't here.

Root: [NexLegTiq – The Intelligent Workspace for Modern Law Offices](https://app.notion.com/p/361fd30cf06d818183deda87a78c8d7a)

| Topic file | Covers | Notion sources |
|---|---|---|
| `product.md` | vision, personas, MVP scope, pricing, roadmap, compliance promises | [Roadmap](https://app.notion.com/p/399fd30cf06d80c5b9a9ed9d15aaebf3) · [Business Strategy & GTM](https://app.notion.com/p/399fd30cf06d80209b88e437d8fe6f81) · [Personas](https://app.notion.com/p/399fd30cf06d80a8bd11ebeff76b8f1f) · [RICE](https://app.notion.com/p/399fd30cf06d80c199fdc26d4c7f130a) · [MENA Legal Systems](https://app.notion.com/p/399fd30cf06d802c9306f14076ad33ad) · [Competitors](https://app.notion.com/p/399fd30cf06d80acb025cce7d26f0aad) |
| `architecture.md` | monorepo, stack, modules, queues, caching, realtime, infra, budgets | [Technical Architecture](https://app.notion.com/p/394fd30cf06d805881d8ef2109f63666) · [Backend Deep Dive](https://app.notion.com/p/394fd30cf06d80649d90e829f66932b9) · [Flow Charts](https://app.notion.com/p/394fd30cf06d802a88bfcbd64af6e52d) · [Performance](https://app.notion.com/p/399fd30cf06d80dbabf0faa273f0b6e4) |
| `domain-model.md` | canonical entities, enums, invariants | [Entity Models](https://app.notion.com/p/393fd30cf06d804cab6eca340b616279) · [Data Migration & Seeding](https://app.notion.com/p/399fd30cf06d808287d4cdf47f8b91fb) |
| `auth-rbac.md` | tokens, flows, roles, permission matrix, tenant isolation | [Auth & Authz](https://app.notion.com/p/399fd30cf06d80278cfdc092123711a3) · [Security](https://app.notion.com/p/399fd30cf06d80e08d11f41aa9825cd1) |
| `api-conventions.md` | envelope, errors, rate limits, endpoint map, WebSocket | [API Documentation](https://app.notion.com/p/399fd30cf06d80a49566eea28ea8eed3) · [Webhooks](https://app.notion.com/p/399fd30cf06d8085b00fcfaf7649b527) (Phase 4) |
| `frontend.md` | theme tokens, i18n/RTL rules, screens, shortcuts, a11y | [UI/UX](https://app.notion.com/p/393fd30cf06d80e988a8f0c5bc245f03) · [Ant Design](https://app.notion.com/p/394fd30cf06d80bab3a2ede4ac8b56f2) · [Arabic Localization](https://app.notion.com/p/399fd30cf06d80a6ae4fd04303391f6a) · [Onboarding](https://app.notion.com/p/399fd30cf06d8012a475e4c809c10ef8) |
| `workflows.md` | business flows W1–W10, hearing/document/close lifecycles, portal | [Workflows](https://app.notion.com/p/393fd30cf06d80b1b24cc6eaf07b276c) · [Flow Charts](https://app.notion.com/p/394fd30cf06d802a88bfcbd64af6e52d) |
| `ai-ocr.md` | OCR pipeline, AI module, PII redaction, evals | [AI Implementation Guide](https://app.notion.com/p/399fd30cf06d80e4bfeecaef4511adf4) |
| `quality-testing.md` | TS/naming/lint rules, gates, test pyramid, Definition of Done | [Development Guidelines](https://app.notion.com/p/399fd30cf06d8002be06efc3142592eb) · [Testing Strategy](https://app.notion.com/p/399fd30cf06d80e89427fd86426a4a2b) |
| `ops-security.md` | security controls, privacy duties, deploy, backups/DR, monitoring, support | [Deployment](https://app.notion.com/p/399fd30cf06d80eba626ff926e1c2d58) · [Infra Cost](https://app.notion.com/p/399fd30cf06d803aa910f1111088d889) · [DR](https://app.notion.com/p/399fd30cf06d80b3b023c163e05ede0f) · [Incident Response](https://app.notion.com/p/399fd30cf06d8069ae79c0ffd347ec07) · [Backup & Restore](https://app.notion.com/p/399fd30cf06d8031ad67e79ff6f91a9d) · [ToS & Privacy](https://app.notion.com/p/399fd30cf06d80d1a65dc70010a39fc7) · [DPA](https://app.notion.com/p/399fd30cf06d80d8b428d358f34f1bab) · [Troubleshooting](https://app.notion.com/p/399fd30cf06d807c8bdbd0dba1675362) · [Support Playbook](https://app.notion.com/p/399fd30cf06d806fb88ac9a3c512e0be) · [FAQ](https://app.notion.com/p/399fd30cf06d807da129e80d5f431fd5) |
| `glossary.md` | EN↔AR legal terms, code names | [Arabic Localization](https://app.notion.com/p/399fd30cf06d80a6ae4fd04303391f6a) |
| `decisions.md` | **all resolved conflicts (D-###)** — wins over everything else | — |

Not engineering inputs (marketing/sales): [Sales Playbook](https://app.notion.com/p/399fd30cf06d80118518c86763a1b4eb),
[Case Studies](https://app.notion.com/p/399fd30cf06d8000af80d62d393d8847) (illustrative only, D-007),
[ROI Calculator](https://app.notion.com/p/399fd30cf06d802dbe49e5812b829297).
Blank: [User Guide / Help Center](https://app.notion.com/p/399fd30cf06d80b7850bd7c20c75201d) (D-073).

## Delivery systems
- **Jira**: `nexlegtiq.atlassian.net`, project **MVP** (Kanban board 2). Epics = modules; labels `phase-1..5`, `slice-1`, area labels
  (`backend`, `frontend`, `infra`, `ai`, `portal`, `security`). Branch/PR names carry the key.
- **GitHub**: `azaareer93/NexLegTiq` — `develop` (staging) / `main` (prod).
- **Ruflo**: long-term memory (namespaces `nexlegtiq-spec`, `decisions`, `patterns`, `lessons`) — see `docs/ruflo.md`.
