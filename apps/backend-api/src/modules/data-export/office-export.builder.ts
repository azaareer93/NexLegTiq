import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';

import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { ZipFile } from 'yazl';
import { z } from 'zod';

import { csvTable } from './export-csv';
import type { RequestContext } from '../../common/context/request-context';
import { MailService } from '../../common/mail/mail.service';
import { StorageService } from '../../common/storage/storage.service';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';

export const OFFICE_EXPORT_JOB = 'office-export';
export const OfficeExportJobSchema = z.object({ exportId: z.uuid() });
export type OfficeExportJob = z.infer<typeof OfficeExportJobSchema>;

/** How long a finished export stays downloadable (D-184). */
export const EXPORT_DAYS = 7;
const DAY_MS = 86_400_000;
/** The audit rows an export carries: the newest ones (an office's whole history can be millions of rows). */
const AUDIT_ROWS = 50_000;

interface ManifestEntry {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly rows?: number;
}

/** JSON with BigInt as text (Decimal and Date already serialise as text). */
const json = (value: unknown) =>
  Buffer.from(
    JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2),
  );
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
/** A path segment safe in every ZIP tool: no separators, no control characters, at most 120 characters. */
const segment = (name: string) =>
  [...name]
    .map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? '_' : ch))
    .join('')
    .trim()
    .slice(0, 120) || '_';

/**
 * Builds an office's export (MVP-106, D-184) in the report worker, in the office's tenant context: one JSON file per
 * entity, CSVs of files, clients, invoices and time entries, every live document under `documents/<file>/<folders>/`,
 * and `manifest.json` with the SHA-256 of each entry. The ZIP streams to storage (encrypted at rest when configured),
 * then the requester gets an email that links to the app.
 * shortcut: each entity's JSON is built in memory (fine for an office's tables; page it if an office outgrows that).
 */
@Injectable()
export class OfficeExportBuilder {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly mail: MailService,
    private readonly config: AppConfig,
    private readonly cls: ClsService<RequestContext>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(OfficeExportBuilder.name);
  }

  async run({ exportId }: OfficeExportJob): Promise<Record<string, unknown>> {
    const db = this.prisma.db;
    const row = await db.officeExport.findFirst({ where: { id: exportId } });
    if (!row || row.status === 'READY') return { skipped: 1 };
    await db.officeExport.update({ where: { id: exportId }, data: { status: 'RUNNING' } });
    try {
      const { key, bytes, checksum } = await this.build(exportId);
      const done = await db.officeExport.update({
        where: { id: exportId },
        data: {
          status: 'READY',
          storageKey: key,
          sizeBytes: BigInt(bytes),
          checksum,
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + EXPORT_DAYS * DAY_MS),
        },
        select: { requestedBy: { select: { fullName: true, email: true, uiLanguage: true } } },
      });
      await this.notify(done.requestedBy, exportId);
      return { exportId, bytes };
    } catch (error) {
      await db.officeExport.update({
        where: { id: exportId },
        data: { status: 'FAILED', errorCode: 'SYS-001' },
      });
      throw error;
    }
  }

  private async build(exportId: string) {
    const zip = new ZipFile();
    const manifest: ManifestEntry[] = [];
    const add = (path: string, data: Buffer, rows?: number) => {
      zip.addBuffer(data, path);
      manifest.push({
        path,
        sha256: sha256(data),
        bytes: data.length,
        ...(rows === undefined ? {} : { rows }),
      });
    };
    const data = await this.datasets();
    for (const [name, rows] of Object.entries(data))
      add(`data/${name}.json`, json(rows), rows.length);
    for (const [name, csv] of Object.entries(this.csvs(data))) add(`csv/${name}.csv`, csv);
    await this.documents(zip, manifest);
    add(
      'manifest.json',
      json({
        format: 'nexlegtiq-export/1',
        officeId: this.officeId(),
        createdAt: new Date(),
        entries: manifest,
      }),
    );
    zip.end();

    const key = this.storage.keyFor('exports', `${exportId}.zip`);
    const hash = createHash('sha256');
    let bytes = 0;
    const out = new PassThrough();
    out.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    zip.outputStream.pipe(out);
    await this.storage.put(key, out, { contentType: 'application/zip' });
    return { key, bytes, checksum: hash.digest('hex') };
  }

  /** Every entity of the office, through the tenant-scoped client (never another office's rows). */
  async datasets(): Promise<Record<string, readonly Record<string, unknown>[]>> {
    const db = this.prisma.db;
    const officeId = this.officeId();
    const [office, settings, users] = await Promise.all([
      db.office.findMany({ where: { id: officeId } }),
      db.officeSettings.findMany({ where: { officeId } }),
      // Accounts without their secrets (password hash, MFA, tokens).
      db.user.findMany({
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          role: true,
          uiLanguage: true,
          isActive: true,
          lastLoginAt: true,
          createdAt: true,
        },
      }),
    ]);
    const entities = {
      clients: db.client.findMany(),
      files: db.legalFile.findMany(),
      fileClients: db.fileClient.findMany(),
      fileTeam: db.fileTeamMember.findMany(),
      parties: db.fileParty.findMany(),
      sessions: db.session.findMany(),
      tasks: db.task.findMany(),
      folders: db.documentFolder.findMany(),
      documents: db.document.findMany({ omit: { storageKey: true } }),
      notes: db.fileNote.findMany(),
      timeEntries: db.timeEntry.findMany(),
      invoices: db.invoice.findMany(),
      invoiceLines: db.invoiceLineItem.findMany(),
      retainerEntries: db.retainerEntry.findMany(),
      witnesses: db.witness.findMany(),
      witnessStatements: db.witnessStatement.findMany(),
      timeline: db.caseTimelineEvent.findMany(),
      auditLog: db.auditLog.findMany({
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: AUDIT_ROWS,
        omit: { ipAddress: true, userAgent: true },
      }),
    };
    const loaded = await Promise.all(Object.values(entities));
    const named = Object.fromEntries(
      Object.keys(entities).map((name, i) => [name, loaded[i] ?? []]),
    );
    return { office, settings, users, ...named } as Record<
      string,
      readonly Record<string, unknown>[]
    >;
  }

  private csvs(data: Record<string, readonly Record<string, unknown>[]>): Record<string, Buffer> {
    const pick = (name: string, columns: readonly string[]) =>
      Buffer.from(csvTable(columns, data[name] ?? []), 'utf8');
    return {
      files: pick('files', [
        'fileNumber',
        'title',
        'fileType',
        'status',
        'priority',
        'openingDate',
        'closingDate',
      ]),
      clients: pick('clients', ['displayName', 'clientType', 'email', 'phone', 'createdAt']),
      invoices: pick('invoices', [
        'invoiceNumber',
        'status',
        'currency',
        'subtotal',
        'taxAmount',
        'total',
        'issueDate',
        'dueDate',
        'paidAt',
      ]),
      timeEntries: pick('timeEntries', [
        'workDate',
        'durationHours',
        'description',
        'isBillable',
        'hourlyRate',
        'amount',
        'currency',
      ]),
    };
  }

  /** Live, scanned documents under `documents/<file number>/<folders…>/<name>`, checksummed from their upload. */
  private async documents(zip: ZipFile, manifest: ManifestEntry[]): Promise<void> {
    const db = this.prisma.db;
    const [docs, folders, files] = await Promise.all([
      db.document.findMany({
        where: { deletedAt: null, status: 'READY' },
        select: {
          id: true,
          fileId: true,
          folderId: true,
          originalFilename: true,
          storageKey: true,
          checksumSha256: true,
          sizeBytes: true,
        },
      }),
      db.documentFolder.findMany({
        select: { id: true, parentId: true, name: true, systemKey: true },
      }),
      db.legalFile.findMany({ select: { id: true, fileNumber: true } }),
    ]);
    const byId = new Map(folders.map((f) => [f.id, f]));
    const folderPath = (id: string | null): string[] => {
      const out: string[] = [];
      for (
        let f = id ? byId.get(id) : undefined;
        f && out.length < 10;
        f = f.parentId ? byId.get(f.parentId) : undefined
      ) {
        out.unshift(segment(f.name ?? f.systemKey ?? 'folder'));
      }
      return out;
    };
    const fileNumbers = new Map(files.map((f) => [f.id, segment(f.fileNumber)]));
    for (const d of docs) {
      const path = [
        'documents',
        fileNumbers.get(d.fileId) ?? d.fileId,
        ...folderPath(d.folderId),
        `${d.id.slice(0, 8)}-${segment(d.originalFilename)}`,
      ].join('/');
      zip.addReadStreamLazy(path, (callback) => {
        this.storage.getStream(d.storageKey).then(
          (stream) => callback(null, stream),
          (error: unknown) => callback(error as Error, undefined as never),
        );
      });
      manifest.push({ path, sha256: d.checksumSha256, bytes: Number(d.sizeBytes) });
    }
  }

  private async notify(
    to: { fullName: string; email: string; uiLanguage: 'AR' | 'EN' },
    exportId: string,
  ): Promise<void> {
    const office = await this.prisma.db.office.findFirst({
      where: { id: this.officeId() },
      select: { name: true },
    });
    await this.mail
      .send(to.email, 'export-ready', to.uiLanguage, {
        name: to.fullName,
        officeName: office?.name ?? 'NexLegTiq',
        link: `${this.config.mail.officeAppUrl}/settings?export=${exportId}`,
        days: EXPORT_DAYS,
      })
      // The export is ready either way: Settings lists it.
      .catch((error: unknown) =>
        this.logger.warn({ err: error, exportId }, 'Export email not queued'),
      );
  }

  private officeId(): string {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the context of an export');
    return officeId;
  }
}
