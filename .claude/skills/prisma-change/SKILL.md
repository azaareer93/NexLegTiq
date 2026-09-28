---
name: prisma-change
description: Safe Prisma schema and migration workflow for NexLegTiq — model conventions, tenant registration, indexes, raw SQL for tsvector/pgvector/partial indexes, seed updates, and review checklist. Use for any change to schema.prisma, migrations, or seed data.
---
# Prisma change workflow

1. Check `docs/context/domain-model.md` + `decisions.md`; if diverging, add a `D-###` (via `/adr`) in the same PR.
2. Edit `apps/backend-api/prisma/schema.prisma` following `.claude/rules/prisma.md`:
```prisma
model Session {
  id          String        @id @default(uuid(7)) @db.Uuid
  officeId    String        @map("office_id") @db.Uuid
  fileId      String        @map("file_id") @db.Uuid
  sessionType SessionType   @map("session_type")
  startsAt    DateTime      @map("starts_at") @db.Timestamptz(3)
  endsAt      DateTime?     @map("ends_at") @db.Timestamptz(3)
  outcome     SessionOutcome?
  isCancelled Boolean       @default(false) @map("is_cancelled")
  reminderDays Int[]        @default([7, 3, 1]) @map("reminder_days")
  createdAt   DateTime      @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt   DateTime      @updatedAt @map("updated_at") @db.Timestamptz(3)
  office      Office        @relation(fields: [officeId], references: [id])
  file        LegalFile     @relation(fields: [fileId], references: [id])
  @@index([officeId, startsAt])
  @@index([officeId, fileId])
  @@map("sessions")
}
```
3. Register tenant models in `TENANT_MODELS`.
4. `pnpm nx run backend-api:prisma-migrate --name add_sessions` → open the generated SQL, then append raw SQL when needed:
   - FTS: generated `tsvector` columns or trigger using `nlq_normalize_ar(text)` + `to_tsvector('simple', …)`; GIN index.
   - Trigram: `CREATE INDEX … USING gin (name gin_trgm_ops)`.
   - Partial: `CREATE INDEX … WHERE status = 'OPEN' AND deleted_at IS NULL`.
   - pgvector (Phase 2): `embedding vector(1536)` + `hnsw (embedding vector_cosine_ops)`.
5. Zero-downtime: add nullable → backfill (script in `prisma/data-migrations/`) → make required in a later migration.
6. Update `prisma/seed.ts` for reference data (idempotent upserts keyed by natural keys); demo data only in `seed-demo.ts`.
7. Tests: repository integration test for new constraints (unique per office, FK behavior), and migration applies on a fresh DB in CI.
8. PR: label `needs-human-review`; describe migration, backfill, rollback.
