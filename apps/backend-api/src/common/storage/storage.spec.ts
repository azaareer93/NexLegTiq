import { S3ServiceException } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ClsServiceManager } from 'nestjs-cls';

import { contentDisposition, MAX_URL_TTL_SECONDS, StorageService } from './storage.service';
import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';
import type { ReadinessRegistry } from '../../health/readiness.registry';
import type { RequestContext } from '../context/request-context';
import { TenantRunner } from '../tenancy/tenant-runner';
import { TenantContextMissingError, TenantViolationError } from '../tenancy/tenant.errors';

jest.mock('@aws-sdk/lib-storage', () => ({ Upload: jest.fn() }));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const OFFICE = '01920000-0000-7000-8000-00000000000a';
const KEY = `${OFFICE}/file-1/doc.txt`;
const cls = ClsServiceManager.getClsService<RequestContext>();
const inOffice = <T>(work: () => Promise<T>) =>
  new TenantRunner(cls).run({ officeId: OFFICE as never }, work);
const UploadMock = Upload as unknown as jest.Mock;
const signMock = getSignedUrl as jest.Mock;

function setup(
  send: jest.Mock = jest.fn().mockResolvedValue({ Body: 'stream' }),
  env: Record<string, string> = {},
) {
  const register = jest.fn();
  const service = new StorageService(new AppConfig(parseEnv(testEnv(env))), cls, {
    register,
  } as unknown as ReadinessRegistry);
  Object.assign(service, { client: { send, destroy: jest.fn() } });
  return { service, send, register };
}

const s3Error = (name: string, status: number) =>
  new S3ServiceException({
    name,
    $fault: status >= 500 ? 'server' : 'client',
    $metadata: { httpStatusCode: status },
  });

beforeEach(() => {
  UploadMock.mockReset().mockImplementation(() => ({ done: jest.fn().mockResolvedValue({}) }));
  signMock.mockReset().mockResolvedValue('https://storage.test/signed');
});

describe('StorageService (unit)', () => {
  it('should build keys under the current office from safe segments only', async () => {
    const { service } = setup();
    await inOffice(async () => {
      expect(service.keyFor('file-1', 'doc-2', 'a1b2.pdf')).toBe(`${OFFICE}/file-1/doc-2/a1b2.pdf`);
      for (const bad of [['..'], ['.'], ['a/b'], ['ملف.pdf'], ['']])
        expect(() => service.keyFor(...bad)).toThrow(TenantViolationError);
      expect(() => service.keyFor()).toThrow(TenantViolationError);
    });
    expect(() => service.keyFor('x')).toThrow(TenantContextMissingError);
  });

  it.each([
    ['another office', '01920000-0000-7000-8000-00000000000b/doc.txt'],
    ['a dot-dot segment', `${OFFICE}/../01920000-0000-7000-8000-00000000000b/doc.txt`],
    ['an empty segment', `${OFFICE}//doc.txt`],
    ['the office prefix alone', OFFICE],
    ['a prefix look-alike', `${OFFICE}x/doc.txt`],
  ])(
    'should refuse a key of %s in every operation, even one read back from the database',
    async (_label, key) => {
      const { service, send } = setup();
      await inOffice(async () => {
        await expect(
          service.put(key, Buffer.from('x'), { contentType: 'text/plain' }),
        ).rejects.toBeInstanceOf(TenantViolationError);
        await expect(service.getStream(key)).rejects.toBeInstanceOf(TenantViolationError);
        await expect(service.head(key)).rejects.toBeInstanceOf(TenantViolationError);
        await expect(service.delete(key)).rejects.toBeInstanceOf(TenantViolationError);
        await expect(service.presignedGetUrl(key)).rejects.toBeInstanceOf(TenantViolationError);
      });
      expect(send).not.toHaveBeenCalled();
      expect(UploadMock).not.toHaveBeenCalled();
    },
  );

  it('should request server-side encryption on upload only when S3_SSE=AES256', async () => {
    await inOffice(async () => {
      await setup(undefined, { S3_SSE: 'AES256' }).service.put(KEY, Buffer.from('x'), {
        contentType: 'text/plain',
        contentLength: 1,
      });
      expect(UploadMock.mock.calls[0]?.[0].params).toMatchObject({
        Key: KEY,
        ContentType: 'text/plain',
        ContentLength: 1,
        ServerSideEncryption: 'AES256',
      });

      await setup().service.put(KEY, Buffer.from('x'), { contentType: 'text/plain' });
      expect(UploadMock.mock.calls[1]?.[0].params).not.toHaveProperty('ServerSideEncryption');
    });
  });

  it('should map storage failures to STO codes and a missing object to RES-001 / null', async () => {
    await inOffice(async () => {
      UploadMock.mockImplementation(() => ({
        done: jest.fn().mockRejectedValue(s3Error('InternalError', 500)),
      }));
      signMock.mockRejectedValue(new Error('no credentials'));
      const failing = setup(jest.fn().mockRejectedValue(s3Error('InternalError', 500))).service;
      await expect(
        failing.put(KEY, Buffer.from('x'), { contentType: 'text/plain' }),
      ).rejects.toMatchObject({ code: 'STO-001' });
      await expect(failing.getStream(KEY)).rejects.toMatchObject({ code: 'STO-002' });
      await expect(failing.head(KEY)).rejects.toMatchObject({ code: 'STO-002' });
      await expect(failing.presignedGetUrl(KEY)).rejects.toMatchObject({ code: 'STO-002' });
      await expect(failing.delete(KEY)).rejects.toMatchObject({ code: 'STO-003' });

      const missing = setup(jest.fn().mockRejectedValue(s3Error('NoSuchKey', 404))).service;
      await expect(missing.getStream(KEY)).rejects.toMatchObject({ code: 'RES-001' });
      await expect(missing.head(KEY)).resolves.toBeNull();

      await expect(
        setup(jest.fn().mockResolvedValue({})).service.getStream(KEY),
      ).rejects.toMatchObject({ code: 'STO-002' });
    });
  });

  it('should keep download links short and always as attachments', async () => {
    const { service } = setup();
    await inOffice(async () => {
      await service.presignedGetUrl(KEY);
      await service.presignedGetUrl(KEY, {
        expiresIn: 7 * 86_400,
        filename: 'عقد.pdf',
        contentType: 'application/pdf',
      });
      await service.presignedGetUrl(KEY, { expiresIn: 0 });
    });
    const [first, second, third] = signMock.mock.calls;
    expect(first?.[2]).toEqual({ expiresIn: 300 });
    expect(first?.[1].input.ResponseContentDisposition).toBe(
      'attachment; filename="doc.txt"; filename*=UTF-8\'\'doc.txt',
    );
    expect(second?.[2]).toEqual({ expiresIn: MAX_URL_TTL_SECONDS });
    expect(second?.[1].input).toMatchObject({
      ResponseContentType: 'application/pdf',
      ResponseContentDisposition: expect.stringContaining('attachment;'),
    });
    expect(third?.[2]).toEqual({ expiresIn: 1 });
  });

  it('should register a storage readiness check (HeadBucket) that fails when storage does', async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const { service, register } = setup(send);
    service.onModuleInit();
    const [name, check] = register.mock.calls[0] ?? [];
    expect(name).toBe('storage');
    await expect(check()).resolves.toBeUndefined();
    expect(send.mock.calls[0]?.[0].input).toEqual({ Bucket: 'nexlegtiq-documents-local' });
    await expect(check()).rejects.toThrow('ECONNREFUSED');
    service.onModuleDestroy();
  });
});

describe('contentDisposition', () => {
  it('should keep the UTF-8 name, encode RFC 5987 specials and give an ASCII fallback without quotes', () => {
    expect(contentDisposition('عقد "نهائي".pdf')).toBe(
      `attachment; filename="___ _______.pdf"; filename*=UTF-8''${encodeURIComponent('عقد "نهائي".pdf')}`,
    );
    expect(contentDisposition("it's (final)*.pdf")).toBe(
      `attachment; filename="it's (final)*.pdf"; filename*=UTF-8''it%27s%20%28final%29%2A.pdf`,
    );
  });
});
