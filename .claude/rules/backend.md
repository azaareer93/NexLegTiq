---
paths:
  - "apps/backend-api/**"
  - "apps/backend-api-e2e/**"
---
# Backend rules (NestJS 11)

- Module layout: `module / controller / service / repository / dto (re-exports shared-contracts) / x.errors.ts / __tests__`.
  Controllers are thin: guards + `ZodValidationPipe(schema)` + call service + return data (the envelope interceptor wraps it).
- Every controller: `@ApiTags`, `@ApiBearerAuth('JWT')`, permission decorator, Swagger responses generated from Zod.
- Services get context from `ClsService` (`officeId`, `userId`, `permissions`) — never accept `officeId` from the request body/path.
- Load files for mutation only via `CaseAccessService.assertFileAccess(fileId, 'read'|'write')`.
- Writes: one transaction covering the entity + timeline event + audit row; enqueue jobs **after** commit so workers
  never see uncommitted rows: `UnitOfWork.run((tx, afterCommit) => …)` + `QueueProducer.enqueue` (D-084).
- Throw `AppException` subclasses with codes from `docs/context/api-conventions.md`; never `throw new Error` for expected cases.
- Workers: `@Processor(QUEUE.X, workerOptions(QUEUE.X))` classes extending `TenantProcessor` in `src/modules/*/workers/`
  (it validates the payload and runs `handle` in `TenantRunner` with the job's office and request id), registered only in
  `WorkerModule`, idempotent by job id,
  log with `requestId` from job data.
- Logging via injected `PinoLogger`; no `console.*`; never log bodies, tokens, or document text.
- Config only through the typed `AppConfig` (Zod-validated env). Add new env vars to `env.schema.ts` **and** `.env.example`.
- Tests: unit next to code (`*.spec.ts`), data-layer integration in `apps/backend-api/src/**/*.int.spec.ts` (`nx run backend-api:integration`, real PostgreSQL, two seeded offices; tenant models go in `tenant-isolation.matrix.ts`), HTTP journeys in `apps/backend-api-e2e`; every new endpoint gets
  happy path + validation + permission + cross-tenant (404) cases.
- Skill to use: `nest-module` for new modules/endpoints, `tenant-isolation` for anything touching data access.
