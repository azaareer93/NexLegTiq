---
name: nest-module
description: Pattern for adding or extending a NestJS module/endpoint in apps/backend-api — contract, controller, service, repository, errors, audit/timeline, queue hand-off, Swagger, and tests. Use when creating endpoints, services, or background jobs in the backend.
---
# NestJS module / endpoint recipe

## 1. Contract first (`packages/shared-contracts/src/<resource>.contract.ts`)
```ts
import { z } from 'zod';
import { FileType, Priority, BillingMethod } from '@nexlegtiq/shared-types';

export const CreateCaseSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(5000).optional(),
  fileType: z.enum(FileType),
  subType: z.string().trim().max(100).optional(),
  clientIds: z.array(z.uuid()).min(1),
  responsibleLawyerId: z.uuid(),
  responsibleParalegalId: z.uuid().optional(),
  priority: z.enum(Priority).default('MEDIUM'),
  billingMethod: z.enum(BillingMethod),
  hourlyRate: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  courtId: z.uuid().optional(),
  judgeId: z.uuid().optional(),
});
export type CreateCaseInput = z.infer<typeof CreateCaseSchema>;
```
Response schemas describe the public shape (no internal columns). Query schemas coerce and allow-list sort fields.

## 2. Controller (thin)
```ts
@ApiTags('cases')
@ApiBearerAuth('JWT')
@Controller('cases')
export class CasesController {
  constructor(private readonly cases: CasesService) {}

  @Post()
  @RequirePermissions('create:case')
  @ApiZodBody(CreateCaseSchema) @ApiZodResponse(201, CaseResponseSchema)
  create(@Body(new ZodValidationPipe(CreateCaseSchema)) dto: CreateCaseInput) {
    return this.cases.create(dto);
  }

  @Get()
  @RequireAnyPermission('view:all:cases', 'view:assigned:cases')
  list(@Query(new ZodValidationPipe(CaseQuerySchema)) q: CaseQuery) {
    return this.cases.list(q); // returns { items, pagination } → envelope interceptor maps to data/meta
  }
}
```

## 3. Service (orchestration) — write recipe
validate business rules → authorize/scope (`CaseAccessService`) → `prisma.$transaction` (entity + timeline + audit) →
`afterCommit(() => queue.add(...))` → cache invalidation → structured log. Throw `AppException` subclasses
(`BusinessRuleException('BIZ-003', …)`), never generic errors.

## 4. Repository
Only place with Prisma calls for the aggregate; uses the tenant-extended client; `select` explicit fields; pagination helper
`paginate(query, { page, limit })`; no business logic.

## 5. Async jobs
Queue name from `QUEUE` const (`architecture.md#queues`); payload `{ officeId, requestId, ...ids }` (ids only, no blobs);
`jobId` deterministic when idempotency matters (e.g. `reminder:${reminderId}`).

## 6. Tests
- Unit: service with mocked repository/queue/cls — each business rule and error code.
- Integration (`apps/backend-api-e2e`): happy path, VAL-001 details, 403 for a role without permission, 404 cross-tenant,
  side effects (timeline row, audit row, job enqueued → `drainQueue`).
- Add to `tenant-isolation.matrix.ts`.

## 7. Wiring checklist
Module imported in `AppModule` · permissions exist in `permissions.ts` · error codes added to `api-conventions.md` if new ·
Swagger visible at `/api/docs` · env vars in `env.schema.ts` + `.env.example` · shared-api-client method + React Query hook if FE needs it.
