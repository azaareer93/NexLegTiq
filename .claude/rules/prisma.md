---
paths:
  - "apps/backend-api/prisma/**"
  - "**/*.prisma"
---
# Prisma schema & migrations rules

- Canonical model: `docs/context/domain-model.md`; changes that diverge need a `D-###` in `decisions.md`.
- IDs `String @id @default(uuid(7)) @db.Uuid`; `createdAt @default(now()) @db.Timestamptz(3)`, `updatedAt @updatedAt`.
- Tenant tables: `officeId String @db.Uuid` (non-null) + relation + `@@index([officeId, …])` matching the main list query.
  Register the model in `TENANT_MODELS` (tenant extension) in the same PR.
- Enums UPPER_SNAKE; tables/columns snake_case via `@@map`/`@map`; money `Decimal @db.Decimal(14,2)`.
- Unique business keys are per office: `@@unique([officeId, fileNumber])`.
- Migrations: `prisma migrate dev --name <verb_noun>`; review generated SQL; add raw SQL for extensions, tsvector triggers,
  partial/GIN indexes in the same migration; expand/contract for renames (never drop+add in one release).
- Never edit an applied migration. Never run `migrate reset` against anything but local.
- PR with migrations gets label `needs-human-review`.
- Skill to use: `prisma-change`.
