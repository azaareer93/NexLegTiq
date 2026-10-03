---
name: tenant-isolation
description: NexLegTiq multi-tenant data-access rules and code patterns — CLS context, Prisma $extends tenant extension, runInTenant for workers, cache/storage key prefixes, and the cross-tenant test pattern. Use for any code that reads or writes tenant data, adds a model, a queue job, a cache key, or a WebSocket event.
---
# Tenant isolation (D-018, D-019, D-058)

## Rules
1. Tenant models (🔒 in `docs/context/domain-model.md`) are listed in `TENANT_MODELS` (`apps/backend-api/src/database/tenant-models.ts`)
   and in `tenant-isolation.matrix.ts` next to it (a spec fails if either misses a model with a required `officeId`).
2. `officeId` comes only from `ClsService` (set by `TenantInterceptor` from the JWT, or by `runInTenant` in workers).
3. The Prisma client used by repositories is the **extended** client; the raw client is only for migrations/seed/platform-admin code
   (`PrismaService.unscoped()` — grep for it in review; every use needs a comment explaining why).
4. Not found in current office ⇒ `NotFoundException` (`RES-001`) — same response whether it exists elsewhere or not.
5. Keys: cache `CacheKeys.x(officeId, …)` → `o:{officeId}:…`; storage `{officeId}/{fileId}/{documentId}/…`; WS rooms `office:{id}` / `user:{id}`.
6. Job payloads always include `officeId` and `requestId`.

## Where things live
`src/common/tenancy/`: `tenant-scope.ts` (pure rules, unit-tested per operation), `tenant.extension.ts`, `tenant.interceptor.ts`
(CLS from `req.user`), `tenant-runner.ts` (`TenantRunner.run({officeId, requestId}, fn)` for jobs), `tenant-keys.ts`
(`CacheKeys.tenant`, `documentStorageKey`, `assertStorageKeyInOffice`). Violations throw `TenantViolationError` /
`TenantContextMissingError` (500 SYS-001).

## Workers
```ts
// Producer (in the request): officeId/requestId are added from CLS, never passed by the caller (D-084).
await this.uow.run(async (tx, afterCommit) => {
  const doc = await tx.document.create({ … });
  afterCommit(() => this.queues.enqueue(QUEUE.OCR, 'process-document', { documentId: doc.id }));
});

// Consumer (registered in WorkerModule only): TenantProcessor validates the payload and runs handle() in the job's office.
@Processor(QUEUE.OCR, workerOptions(QUEUE.OCR))
export class OcrWorker extends TenantProcessor<OcrJob> {
  protected readonly schema = OcrJobSchema; // z.object({ documentId: z.uuid() })
  constructor(tenant: TenantRunner, prisma: PrismaService, logger: PinoLogger, private readonly ocr: OcrService) {
    super(tenant, prisma, logger);
  }
  protected handle(job: Job<OcrJob & TenantJobData>, signal: AbortSignal) { return this.ocr.process(job.data.documentId, signal); }
}
```

## Test pattern (integration)
```ts
describe('GET /api/v1/cases/:id (tenant isolation)', () => {
  it('should return 404 when the case belongs to another office', async () => {
    const other = await factories.legalFile.create({ officeId: officeB.id });
    await request(app).get(`/api/v1/cases/${other.id}`).set(auth(officeA.lawyer)).expect(404)
      .expect(({ body }) => expect(body.error.code).toBe('RES-001'));
  });
});
```
New tenant model: add it to `TENANT_MODELS` and `TENANT_ISOLATION_MATRIX` (data layer, `pnpm nx run backend-api:integration`).
New endpoint: give its matrix entry an `http` section so the generic suite covers list/get/update/delete → 404 RES-001.
