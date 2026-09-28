---
name: tenant-isolation
description: NexLegTiq multi-tenant data-access rules and code patterns — CLS context, Prisma $extends tenant extension, runInTenant for workers, cache/storage key prefixes, and the cross-tenant test pattern. Use for any code that reads or writes tenant data, adds a model, a queue job, a cache key, or a WebSocket event.
---
# Tenant isolation (D-018, D-019, D-058)

## Rules
1. Tenant models (🔒 in `docs/context/domain-model.md`) are listed in `TENANT_MODELS` (`apps/backend-api/src/infra/prisma/tenant-models.ts`).
2. `officeId` comes only from `ClsService` (set by `TenantInterceptor` from the JWT, or by `runInTenant` in workers).
3. The Prisma client used by repositories is the **extended** client; the raw client is only for migrations/seed/platform-admin code
   (`PrismaService.unscoped()` — grep for it in review; every use needs a comment explaining why).
4. Not found in current office ⇒ `NotFoundException` (`RES-001`) — same response whether it exists elsewhere or not.
5. Keys: cache `CacheKeys.x(officeId, …)` → `o:{officeId}:…`; storage `{officeId}/{fileId}/{documentId}/…`; WS rooms `office:{id}` / `user:{id}`.
6. Job payloads always include `officeId` and `requestId`.

## Extension sketch
```ts
// infra/prisma/tenant.extension.ts
export const tenantExtension = (cls: ClsService<AppCls>) =>
  Prisma.defineExtension({
    name: 'tenant',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!TENANT_MODELS.has(model)) return query(args);
          const officeId = cls.get('officeId');
          if (!officeId) throw new TenantContextMissingError(model, operation);
          return query(scopeArgs(operation, args, officeId)); // adds where.officeId / data.officeId; rejects foreign officeId in data
        },
      },
    },
  });
```
`scopeArgs` handles: findUnique/findUniqueOrThrow (convert to findFirst with officeId or verify after fetch), findFirst/findMany/count/
aggregate/groupBy (`where`), create/createMany (`data`), update/updateMany/delete/deleteMany/upsert (`where` + `data`).
Nested writes into tenant relations must also carry officeId — prefer explicit repository calls over deep nested creates.

## Workers
```ts
@Processor(QUEUE.OCR)
export class OcrWorker extends WorkerHost {
  constructor(private readonly tenant: TenantRunner, private readonly ocr: OcrService) { super(); }
  async process(job: Job<OcrJob>) {
    return this.tenant.run({ officeId: job.data.officeId, requestId: job.data.requestId }, () => this.ocr.process(job.data.documentId));
  }
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
Add the endpoint to `test/tenant-isolation.matrix.ts` so the generic suite covers list/get/update/delete.
