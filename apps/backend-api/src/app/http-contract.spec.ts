import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { z } from 'zod';

import { BusinessRuleException } from '../common/errors/app.exception';
import { PaginatedResult } from '../common/http/paginated-result';
import { ZodValidationPipe } from '../common/http/zod-validation.pipe';
import { AppModule } from './app.module';
import { Public } from '../common/auth/public.decorator';
import { configureApp } from './configure-app';

const CreateThingSchema = z.object({ title: z.string().min(3), amount: z.string().regex(/^\d+(\.\d{1,2})?$/) });

// Public: this suite tests the envelope and error mapping, not authentication.
@Public()
@Controller('__contract__')
class ContractTestController {
  @Get('item')
  item(): { id: string } {
    return { id: 'item-1' };
  }

  @Get('empty')
  empty(): void {
    return undefined;
  }

  @Get('page')
  page(): PaginatedResult<number> {
    return PaginatedResult.of([1, 2], { page: 1, limit: 2, total: 3 });
  }

  @Post('things')
  create(@Body(new ZodValidationPipe(CreateThingSchema)) body: z.output<typeof CreateThingSchema>): typeof body {
    return body;
  }

  @Get('business')
  business(): never {
    throw new BusinessRuleException('BIZ-003', 'Open tasks block close');
  }

  @Get('prisma-unique')
  prismaUnique(): never {
    const error = Object.assign(new Error('Unique constraint failed on the fields: (`email`)'), { code: 'P2002' });
    Object.defineProperty(error, 'name', { value: 'PrismaClientKnownRequestError' });
    throw error;
  }

  @Get('server-zod')
  serverZod(): never {
    // e.g. an AI provider returned JSON that does not match our schema
    z.object({ summary: z.string() }).parse({ summary: 42 });
    throw new Error('unreachable');
  }

  @Get('crash')
  crash(): never {
    throw new Error('connection string postgres://user:secret@db/internal leaked');
  }
}

@Module({ controllers: [ContractTestController] })
class ContractTestModule {}

describe('HTTP contract (envelope + errors)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, ContractTestModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  describe('success envelope', () => {
    it('should wrap data with meta.timestamp and meta.requestId matching x-request-id', async () => {
      const res = await http().get('/api/v1/__contract__/item').set('x-request-id', 'contract-test-0001');

      expect(res.status).toBe(200);
      expect(res.headers['x-request-id']).toBe('contract-test-0001');
      expect(res.body).toEqual({
        success: true,
        data: { id: 'item-1' },
        meta: { timestamp: expect.any(String), requestId: 'contract-test-0001' },
      });
      expect(new Date(res.body.meta.timestamp).toISOString()).toBe(res.body.meta.timestamp);
    });

    it.each(['<script>x</script>', 'has spaces in it', 'x'.repeat(200), 'short'])(
      'should replace an unsafe x-request-id (%s) with a generated one',
      async (hostile) => {
        const res = await http().get('/api/v1/__contract__/item').set('x-request-id', hostile);

        expect(res.headers['x-request-id']).not.toBe(hostile);
        expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
        expect(res.body.meta.requestId).toBe(res.headers['x-request-id']);
      },
    );

    it('should sanitise a hostile x-request-id on the error path too', async () => {
      const res = await http().get('/api/v1/does-not-exist').set('x-request-id', '<img src=x>');

      expect(res.status).toBe(404);
      expect(res.body.meta.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('should generate a request id when none is sent', async () => {
      const res = await http().get('/api/v1/__contract__/item');

      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.body.meta.requestId).toBe(res.headers['x-request-id']);
    });

    it('should return data: null when the handler returns nothing', async () => {
      const res = await http().get('/api/v1/__contract__/empty');

      expect(res.body).toMatchObject({ success: true, data: null });
    });

    it('should move pagination into meta for a PaginatedResult', async () => {
      const res = await http().get('/api/v1/__contract__/page');

      expect(res.body.data).toEqual([1, 2]);
      expect(res.body.meta.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2, hasMore: true });
    });
  });

  describe('error envelope', () => {
    it('should return 400 VAL-001 with field details when the body is invalid', async () => {
      const res = await http().post('/api/v1/__contract__/things').send({ title: 'x', amount: '1.234' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        success: false,
        error: {
          code: 'VAL-001',
          message: 'Invalid input',
          details: [
            { field: 'title', message: expect.any(String) },
            { field: 'amount', message: expect.any(String) },
          ],
        },
        meta: { timestamp: expect.any(String), requestId: expect.any(String) },
      });
    });

    it('should pass a valid body through parsed', async () => {
      const res = await http().post('/api/v1/__contract__/things').send({ title: 'Lease', amount: '10.50' });

      expect(res.status).toBe(201);
      expect(res.body.data).toEqual({ title: 'Lease', amount: '10.50' });
    });

    it('should map a business rule to its code and catalog status', async () => {
      const res = await http().get('/api/v1/__contract__/business');

      expect(res.status).toBe(422);
      expect(res.body.error).toEqual({ code: 'BIZ-003', message: 'Open tasks block close' });
    });

    it('should map Prisma P2002 to 409 RES-002 without the database message', async () => {
      const res = await http().get('/api/v1/__contract__/prisma-unique');

      expect(res.status).toBe(409);
      expect(res.body.error).toEqual({ code: 'RES-002', message: 'Resource already exists' });
    });

    it('should return 500 SYS-001 without leaking internals for unknown errors', async () => {
      const res = await http().get('/api/v1/__contract__/crash');

      expect(res.status).toBe(500);
      expect(res.body.error).toEqual({ code: 'SYS-001', message: 'Internal server error' });
      expect(JSON.stringify(res.body)).not.toContain('postgres://');
    });

    it('should return 500 SYS-001 (not VAL-001) when server-side Zod parsing fails', async () => {
      const res = await http().get('/api/v1/__contract__/server-zod');

      expect(res.status).toBe(500);
      expect(res.body.error).toEqual({ code: 'SYS-001', message: 'Internal server error' });
    });

    it('should return 404 RES-001 for an unknown route without echoing the URL', async () => {
      const res = await http().get('/api/v1/does-not-exist?token=abc123');

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ success: false, error: { code: 'RES-001', message: 'Resource not found' } });
      expect(JSON.stringify(res.body)).not.toContain('abc123');
      expect(res.body.meta.requestId).toBe(res.headers['x-request-id']);
    });

    it('should return 400 VAL-001 for malformed JSON', async () => {
      const res = await http()
        .post('/api/v1/__contract__/things')
        .set('content-type', 'application/json')
        .send('{"title": ');

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, error: { code: 'VAL-001' } });
    });

    it('should reject bodies over 1 MB with an error envelope', async () => {
      const res = await http()
        .post('/api/v1/__contract__/things')
        .send({ title: 'x'.repeat(1024 * 1024 + 1), amount: '1' });

      expect(res.status).toBe(413);
      expect(res.body).toMatchObject({ success: false, error: { code: 'VAL-006', message: 'Payload too large' } });
    });
  });
});
