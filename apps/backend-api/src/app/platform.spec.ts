import { Controller, Get, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { ReadinessRegistry } from '../health/readiness.registry';
import { MetricsService } from '../metrics/metrics.service';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';

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
  const moduleRef = await Test.createTestingModule({ imports: [AppModule, PlatformTestModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, bufferLogs: true });
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
    it('should answer liveness at /health outside the /api/v1 prefix', async () => {
      const res = await http().get('/health');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, data: { status: 'ok' } });
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
    });

    it('should not allow an unknown origin', async () => {
      const res = await http().get('/health').set('origin', 'https://evil.example');

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
      expect(res.body.components.securitySchemes.JWT).toMatchObject({ type: 'http', scheme: 'bearer' });
      expect(res.body.paths['/health'].get.responses['200'].content['application/json'].schema).toMatchObject({
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
  });
});

describe('readiness failure', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp();
    const registry = app.get(ReadinessRegistry);
    registry.register('db', () => Promise.resolve());
    registry.register('redis', () => Promise.reject(new Error('ECONNREFUSED redis://:secret@internal:6379')));
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
