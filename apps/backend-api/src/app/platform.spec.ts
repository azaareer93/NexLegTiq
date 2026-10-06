import { Controller, Get, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { QueueModule } from '../common/queue/queue.module';
import { QueueStubModule } from '../common/queue/testing';
import { StorageService } from '../common/storage/storage.service';
import { PrismaService } from '../database/prisma.service';
import { ReadinessRegistry } from '../health/readiness.registry';
import { MetricsService } from '../metrics/metrics.service';
import { AppModule } from './app.module';
import { Public } from '../common/auth/public.decorator';
import { configureApp } from './configure-app';

// Public: this suite tests the HTTP platform (headers, compression, metrics), not authentication.
@Public()
@Controller('__platform__/items')
class PlatformTestController {
  @Get(':id')
  item(): { big: string } {
    return { big: 'x'.repeat(4096) };
  }
}

@Module({ controllers: [PlatformTestController] })
class PlatformTestModule {}

async function createApp(): Promise<NestExpressApplication> {
  // No database in unit tests: the real PrismaService would register a failing `db` readiness check.
  const moduleRef = await Test.createTestingModule({ imports: [AppModule, PlatformTestModule] })
    // No Redis in unit tests either: the real QueueModule would register a failing `redis` readiness check.
    .overrideModule(QueueModule)
    .useModule(QueueStubModule)
    .overrideProvider(PrismaService)
    .useValue({})
    // No object storage either: the real StorageService would register a failing `storage` readiness check.
    .overrideProvider(StorageService)
    .useValue({})
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    bufferLogs: true,
  });
  configureApp(app);
  await app.init();
  return app;
}

describe('HTTP platform (health, security, docs, metrics)', () => {
  let app: NestExpressApplication;
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('health', () => {
    it('should answer liveness at /health', async () => {
      const res = await http().get('/health');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, data: { status: 'ok' } });
    });

    it('should not serve health under the /api/v1 prefix', async () => {
      expect((await http().get('/api/v1/health')).status).toBe(404);
    });

    it('should carry the request id on unprefixed routes too', async () => {
      const res = await http().get('/health').set('x-request-id', 'health-probe-0001');

      expect(res.headers['x-request-id']).toBe('health-probe-0001');
      expect(res.body.meta.requestId).toBe('health-probe-0001');
    });

    it('should report ready with per-check status when all checks pass', async () => {
      const res = await http().get('/health/ready');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ status: 'ok', checks: {} });
    });
  });

  describe('security headers, CORS and compression', () => {
    it('should set helmet headers', async () => {
      const res = await http().get('/health');

      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('should allow a configured SPA origin and expose x-request-id', async () => {
      const res = await http().get('/health').set('origin', 'http://localhost:4200');

      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:4200');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-expose-headers']).toContain('x-request-id');
      expect(res.headers['access-control-expose-headers']).toContain('Retry-After');
    });

    it('should not allow an unknown origin', async () => {
      const res = await http().get('/health').set('origin', 'https://evil.example');

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('should answer a CORS preflight from an allowed origin', async () => {
      const res = await http()
        .options('/api/v1/__platform__/items/1')
        .set('origin', 'http://localhost:4202')
        .set('access-control-request-method', 'POST')
        .set('access-control-request-headers', 'content-type,authorization,x-request-id');

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:4202');
      expect(res.headers['access-control-allow-methods']).toContain('POST');
      expect(res.headers['access-control-allow-headers']).toContain('authorization');
    });

    it('should not grant a CORS preflight from an unknown origin', async () => {
      const res = await http()
        .options('/api/v1/__platform__/items/1')
        .set('origin', 'https://evil.example')
        .set('access-control-request-method', 'POST');

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('should gzip large responses when the client accepts it', async () => {
      const res = await http().get('/api/v1/__platform__/items/1').set('accept-encoding', 'gzip');

      expect(res.headers['content-encoding']).toBe('gzip');
    });
  });

  describe('swagger', () => {
    it('should serve the OpenAPI document with prefixed API routes and bearer auth', async () => {
      const res = await http().get('/api/docs-json');

      expect(res.status).toBe(200);
      expect(res.body.info.title).toBe('NexLegTiq API');
      expect(Object.keys(res.body.paths)).toEqual(
        expect.arrayContaining(['/health', '/health/ready', '/api/v1/__platform__/items/{id}']),
      );
      expect(res.body.components.securitySchemes.JWT).toMatchObject({
        type: 'http',
        scheme: 'bearer',
      });
      expect(
        res.body.paths['/health'].get.responses['200'].content['application/json'].schema,
      ).toMatchObject({
        required: ['success', 'data', 'meta'],
      });
    });

    it('should serve the Swagger UI', async () => {
      const res = await http().get('/api/docs/');

      expect(res.status).toBe(200);
      expect(res.text).toContain('swagger-ui');
    });
  });

  describe('metrics', () => {
    it('should record request duration labelled by route template, not raw URL', async () => {
      await http().get('/api/v1/__platform__/items/123');

      const output = await app.get(MetricsService).render();

      expect(output).toContain('route="/api/v1/__platform__/items/:id"');
      expect(output).not.toContain('items/123');
    });

    it('should count unmatched requests and preflights under a fixed label', async () => {
      await http().get('/api/v1/nope/987654');
      await http()
        .options('/api/v1/nope')
        .set('origin', 'http://localhost:4200')
        .set('access-control-request-method', 'GET');

      const output = await app.get(MetricsService).render();

      expect(output).toContain('method="OPTIONS",route="unmatched",status_code="204"');
      expect(output).toContain('method="GET",route="unmatched",status_code="404"');
      expect(output).not.toContain('987654');
    });
  });
});

describe('readiness failure', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp();
    const registry = app.get(ReadinessRegistry);
    registry.register('db', () => Promise.resolve());
    registry.register('redis', () =>
      Promise.reject(new Error('ECONNREFUSED redis://:secret@internal:6379')),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return 503 SYS-002 naming the failed check without leaking the reason', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.error).toEqual({
      code: 'SYS-002',
      message: 'Service unavailable',
      details: [{ field: 'redis', message: 'unavailable' }],
    });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});

describe('swagger disabled (production default)', () => {
  let app: NestExpressApplication | undefined;
  const previous = process.env['SWAGGER_ENABLED'];

  beforeAll(async () => {
    process.env['SWAGGER_ENABLED'] = 'false';
    try {
      app = await createApp();
    } finally {
      process.env['SWAGGER_ENABLED'] = previous; // config is read at compile time; restore immediately
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('should not serve the docs while the API itself is up', async () => {
    if (!app) throw new Error('app failed to start');
    const server = app.getHttpServer();

    expect((await request(server).get('/health')).status).toBe(200);
    expect((await request(server).get('/api/docs-json')).status).toBe(404);
  });
});
