import type { Readable } from 'node:stream';

import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import { AppConfig } from '../../config/app-config';
import { ReadinessRegistry } from '../../health/readiness.registry';
import type { RequestContext } from '../context/request-context';
import { AppException, ResourceNotFoundException } from '../errors/app.exception';
import type { ErrorCode } from '@nexlegtiq/shared-types';
import { TenantContextMissingError, TenantViolationError } from '../tenancy/tenant.errors';

/** Presigned download links live 5 minutes by default (api-conventions.md: `{downloadUrl, expiresIn: 300}`). */
export const DEFAULT_URL_TTL_SECONDS = 300;

export interface StoredObject {
  readonly key: string;
  readonly size: number;
  readonly contentType: string | undefined;
  readonly etag: string | undefined;
}

/** One key segment: letters, digits, '.', '_' and '-' only — no '/', no '..', so callers cannot climb out of their prefix. */
const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,200}$/;

/**
 * S3-compatible object storage (RustFS locally, R2/S3 in production; D-020, D-078, D-085). Every key belongs to the current
 * office: `keyFor(...)` builds `{officeId}/…` from the request or job context, and every operation refuses a key outside
 * that prefix (D-018). Originals keep their names in the database (D-035); keys are opaque segments.
 * Failures map to STO-001 (upload), STO-002 (download, links, lookups) and STO-003 (delete).
 */
@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly sse: 'AES256' | undefined;

  constructor(
    config: AppConfig,
    private readonly cls: ClsService<RequestContext>,
    private readonly readiness: ReadinessRegistry,
  ) {
    const storage = config.storage;
    this.bucket = storage.bucket;
    this.sse = storage.sse === 'AES256' ? 'AES256' : undefined;
    this.client = new S3Client({
      endpoint: storage.endpoint,
      region: storage.region,
      forcePathStyle: storage.forcePathStyle,
      credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
    });
  }

  onModuleInit(): void {
    this.readiness.register('storage', async () => {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    });
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  /** `{officeId}/{segment}/…` for the current office, e.g. `keyFor(fileId, documentId, \`${uuid}.pdf\`)` (D-035). */
  keyFor(...segments: string[]): string {
    if (segments.length === 0 || !segments.every((segment) => SEGMENT.test(segment))) {
      throw new TenantViolationError('Storage key segments must be non-empty and contain only [A-Za-z0-9._-]');
    }
    return [this.officeId(), ...segments].join('/');
  }

  /** Streams the body to storage (multipart for large files) with server-side encryption when configured. */
  async put(key: string, body: Readable | Buffer, options: { contentType: string; contentLength?: number }): Promise<void> {
    this.assertOwnKey(key);
    try {
      await new Upload({
        client: this.client,
        params: {
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: options.contentType,
          ...(options.contentLength !== undefined ? { ContentLength: options.contentLength } : {}),
          ...(this.sse ? { ServerSideEncryption: this.sse } : {}),
        },
      }).done();
    } catch (error) {
      throw storageError('STO-001', 'Upload to storage failed', error);
    }
  }

  async getStream(key: string): Promise<Readable> {
    this.assertOwnKey(key);
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return result.Body as Readable;
    } catch (error) {
      if (isNotFound(error)) throw new ResourceNotFoundException();
      throw storageError('STO-002', 'Download from storage failed', error);
    }
  }

  /** Metadata of an object, or null when it does not exist. */
  async head(key: string): Promise<StoredObject | null> {
    this.assertOwnKey(key);
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { key, size: result.ContentLength ?? 0, contentType: result.ContentType, etag: result.ETag };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw storageError('STO-002', 'Storage lookup failed', error);
    }
  }

  /** Idempotent: deleting a missing object succeeds. */
  async delete(key: string): Promise<void> {
    this.assertOwnKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      throw storageError('STO-003', 'Delete from storage failed', error);
    }
  }

  /**
   * A short-lived GET link (D-013: returned as JSON, never a redirect). `filename` sets the download name — Arabic names
   * included (RFC 5987) — without ever being part of the key.
   */
  async presignedGetUrl(key: string, options: { expiresIn?: number; filename?: string; contentType?: string } = {}): Promise<string> {
    this.assertOwnKey(key);
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(options.filename ? { ResponseContentDisposition: contentDisposition(options.filename) } : {}),
      ...(options.contentType ? { ResponseContentType: options.contentType } : {}),
    });
    try {
      return await getSignedUrl(this.client, command, { expiresIn: options.expiresIn ?? DEFAULT_URL_TTL_SECONDS });
    } catch (error) {
      throw storageError('STO-002', 'Could not create a download link', error);
    }
  }

  private officeId(): string {
    const officeId = this.cls.isActive() ? this.cls.get('officeId') : undefined;
    if (!officeId) throw new TenantContextMissingError('storage');
    return officeId;
  }

  private assertOwnKey(key: string): void {
    if (!key.startsWith(`${this.officeId()}/`)) throw new TenantViolationError('Storage key outside the current office');
  }
}

/** `attachment` with an ASCII fallback and the UTF-8 name (RFC 6266/5987), so Arabic filenames survive the download. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function isNotFound(error: unknown): boolean {
  return error instanceof S3ServiceException && (error.name === 'NoSuchKey' || error.name === 'NotFound' || error.$metadata.httpStatusCode === 404);
}

function storageError(code: ErrorCode, message: string, cause: unknown): AppException {
  return new AppException(code, message, undefined, { cause });
}
