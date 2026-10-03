import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { OfficeId } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';

import { AppConfig } from '../../config/app-config';
import { integrationEnv } from '../../config/env.fixture';
import { ReadinessRegistry } from '../../health/readiness.registry';
import { CoreModule } from '../core/core.module';
import { TenantRunner } from '../tenancy/tenant-runner';
import { TenantViolationError } from '../tenancy/tenant.errors';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

/** MVP-35 against real S3-compatible storage (RustFS locally and in CI; D-078, D-085). */
describe('StorageService (S3-compatible storage)', () => {
  let app: INestApplicationContext;
  let storage: StorageService;
  let runner: TenantRunner;
  const officeA = randomUUID() as OfficeId;
  const officeB = randomUUID() as OfficeId;
  const savedEnv = { ...process.env };
  const inOffice = <T>(officeId: OfficeId, work: () => Promise<T>) => runner.run({ officeId }, work);

  beforeAll(async () => {
    Object.assign(process.env, integrationEnv());
    app = await (await Test.createTestingModule({ imports: [CoreModule, StorageModule] }).compile()).init();
    storage = app.get(StorageService);
    runner = new TenantRunner(app.get(ClsService));
    // CI's storage container starts empty; locally the compose init job creates the bucket.
    const config = app.get(AppConfig).storage;
    const admin = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
    await admin.send(new HeadBucketCommand({ Bucket: config.bucket })).catch(() => admin.send(new CreateBucketCommand({ Bucket: config.bucket })));
    admin.destroy();
  });

  afterAll(async () => {
    await app?.close();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  it('should stream an object in and out under the office prefix, then delete it', async () => {
    await inOffice(officeA, async () => {
      const key = storage.keyFor(randomUUID(), `${randomUUID()}.txt`);
      expect(key.startsWith(`${officeA}/`)).toBe(true);
      const content = Buffer.from('مذكرة دفاع — defence brief', 'utf8');

      await storage.put(key, Readable.from(content), { contentType: 'text/plain; charset=utf-8' });
      await expect(storage.head(key)).resolves.toMatchObject({ key, size: content.length, contentType: 'text/plain; charset=utf-8' });

      const chunks: Buffer[] = [];
      for await (const chunk of await storage.getStream(key)) chunks.push(Buffer.from(chunk as Uint8Array));
      expect(Buffer.concat(chunks).toString('utf8')).toBe('مذكرة دفاع — defence brief');

      await storage.delete(key);
      await expect(storage.head(key)).resolves.toBeNull();
      await expect(storage.delete(key)).resolves.toBeUndefined();
      await expect(storage.getStream(key)).rejects.toMatchObject({ code: 'RES-001' });
    });
  });

  it('should hand out a short-lived download link that keeps an Arabic filename', async () => {
    await inOffice(officeA, async () => {
      const key = storage.keyFor(`${randomUUID()}.pdf`);
      await storage.put(key, Buffer.from('%PDF-1.4 test'), { contentType: 'application/pdf' });

      const url = await storage.presignedGetUrl(key, { filename: 'عقد إيجار.pdf' });
      expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('300');
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('%PDF-1.4 test');
      expect(response.headers.get('content-disposition')).toContain(`filename*=UTF-8''${encodeURIComponent('عقد إيجار.pdf')}`);
      await storage.delete(key);
    });
  });

  it("should refuse another office's keys and keys that escape their segment", async () => {
    const keyOfA = await inOffice(officeA, async () => storage.keyFor('doc.txt'));
    await inOffice(officeB, async () => {
      await expect(storage.head(keyOfA)).rejects.toBeInstanceOf(TenantViolationError);
      await expect(storage.presignedGetUrl(keyOfA)).rejects.toBeInstanceOf(TenantViolationError);
      await expect(storage.delete(keyOfA)).rejects.toBeInstanceOf(TenantViolationError);
      expect(() => storage.keyFor('..', 'x')).toThrow(TenantViolationError);
      expect(() => storage.keyFor(`${officeA}/doc.txt`)).toThrow(TenantViolationError);
    });
  });

  it('should report storage as ready', async () => {
    const report = await app.get(ReadinessRegistry).run();
    expect(report.checks['storage']).toMatchObject({ status: 'up' });
  });
});
