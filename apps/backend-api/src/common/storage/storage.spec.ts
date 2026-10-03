import { S3ServiceException } from '@aws-sdk/client-s3';
import { ClsServiceManager } from 'nestjs-cls';

import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';
import type { ReadinessRegistry } from '../../health/readiness.registry';
import type { RequestContext } from '../context/request-context';
import { TenantRunner } from '../tenancy/tenant-runner';
import { TenantContextMissingError, TenantViolationError } from '../tenancy/tenant.errors';
import { contentDisposition, StorageService } from './storage.service';

const OFFICE = '01920000-0000-7000-8000-00000000000a';
const cls = ClsServiceManager.getClsService<RequestContext>();
const inOffice = <T>(work: () => Promise<T>) => new TenantRunner(cls).run({ officeId: OFFICE as never }, work);

function setup(send: jest.Mock = jest.fn().mockResolvedValue({})) {
  const register = jest.fn();
  const service = new StorageService(new AppConfig(parseEnv(testEnv())), cls, { register } as unknown as ReadinessRegistry);
  Object.assign(service, { client: { send, destroy: jest.fn() } });
  return { service, send, register };
}

const s3Error = (name: string, status: number) =>
  new S3ServiceException({ name, $fault: status >= 500 ? 'server' : 'client', $metadata: { httpStatusCode: status } });

describe('StorageService (unit)', () => {
  it('should build keys under the current office from safe segments only', async () => {
    const { service } = setup();
    await inOffice(async () => {
      expect(service.keyFor('file-1', 'doc-2', 'a1b2.pdf')).toBe(`${OFFICE}/file-1/doc-2/a1b2.pdf`);
      for (const bad of [['..'], ['.'], ['a/b'], ['ملف.pdf'], ['']]) expect(() => service.keyFor(...bad)).toThrow(TenantViolationError);
      expect(() => service.keyFor()).toThrow(TenantViolationError);
    });
    expect(() => service.keyFor('x')).toThrow(TenantContextMissingError);
  });

  it('should map storage failures to STO codes and a missing object to RES-001 / null', async () => {
    const key = `${OFFICE}/doc.txt`;
    await inOffice(async () => {
      const failing = setup(jest.fn().mockRejectedValue(s3Error('InternalError', 500))).service;
      await expect(failing.getStream(key)).rejects.toMatchObject({ code: 'STO-002' });
      await expect(failing.head(key)).rejects.toMatchObject({ code: 'STO-002' });
      await expect(failing.delete(key)).rejects.toMatchObject({ code: 'STO-003' });

      const missing = setup(jest.fn().mockRejectedValue(s3Error('NoSuchKey', 404))).service;
      await expect(missing.getStream(key)).rejects.toMatchObject({ code: 'RES-001' });
      await expect(missing.head(key)).resolves.toBeNull();
    });
  });

  it('should register the storage readiness check (HeadBucket) and release the client on shutdown', async () => {
    const { service, send, register } = setup();
    service.onModuleInit();
    const [name, check] = register.mock.calls[0] ?? [];
    expect(name).toBe('storage');
    await check();
    expect(send.mock.calls[0]?.[0].input).toEqual({ Bucket: 'nexlegtiq-documents-local' });
    service.onModuleDestroy();
  });
});

describe('contentDisposition', () => {
  it('should keep the UTF-8 name and give an ASCII fallback without quotes', () => {
    expect(contentDisposition('عقد "نهائي".pdf')).toBe(
      `attachment; filename="___ _______.pdf"; filename*=UTF-8''${encodeURIComponent('عقد "نهائي".pdf')}`,
    );
  });
});
