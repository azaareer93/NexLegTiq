import { Injectable } from '@nestjs/common';
import type {
  DownloadLink,
  PortalUpload,
  PortalOfficeAccess,
  PortalDocument,
  PortalFile,
  PortalFileDetail,
} from '@nexlegtiq/shared-contracts';
import { PORTAL_TIMELINE_EVENT_TYPES } from '@nexlegtiq/shared-types';
import type { OfficeId } from '@nexlegtiq/shared-types';
import type { Request } from 'express';

import { auditRow } from '../../common/audit/audit.service';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { DEFAULT_URL_TTL_SECONDS, StorageService } from '../../common/storage/storage.service';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { ClientInfo } from '../auth/client-info';
import { ClientUploadIntake, toPortalUpload } from '../documents/client-upload-intake';
import { discardBody } from '../documents/upload/multipart';
import { PortalAccounts } from '../portal-auth/portal-accounts';

/** shortcut: no paging — a client has few files; page when one passes this. */
const MAX_FILES = 200;
/** shortcut: no paging — the newest 200 shared documents of a file; page when one passes this. */
const MAX_DOCUMENTS = 200;
const TIMELINE_EVENTS = 100;
/** Scanned clean (D-126): the portal offers nothing else. */
const OFFERED = { in: ['PROCESSING', 'READY'] } satisfies Prisma.EnumDocumentStatusFilter;

const fileSelect = (now: Date) =>
  ({
    id: true,
    fileNumber: true,
    title: true,
    status: true,
    responsibleLawyer: { select: { fullName: true } },
    sessions: {
      where: { isCancelled: false, startsAt: { gte: now } },
      orderBy: { startsAt: 'asc' },
      take: 1,
      select: { startsAt: true, court: { select: { nameAr: true, nameEn: true } } },
    },
  }) satisfies Prisma.LegalFileSelect;
type FileRow = Prisma.LegalFileGetPayload<{ select: ReturnType<typeof fileSelect> }>;

/** A live file the grant's client is linked to (D-003): the only files a portal account reaches. */
const clientFiles = (clientId: string) =>
  ({ deletedAt: null, clients: { some: { clientId } } }) satisfies Prisma.LegalFileWhereInput;

const toFile = (grant: PortalOfficeAccess, row: FileRow): PortalFile => {
  const next = row.sessions[0];
  return {
    id: row.id,
    officeId: grant.officeId,
    officeName: grant.officeName,
    fileNumber: row.fileNumber,
    title: row.title,
    status: row.status,
    lawyerName: row.responsibleLawyer.fullName,
    nextHearing: next
      ? {
          startsAt: next.startsAt.toISOString(),
          courtNameAr: next.court?.nameAr ?? null,
          courtNameEn: next.court?.nameEn ?? null,
        }
      : null,
  };
};

/**
 * What a signed-in client sees (MVP-98, D-186): the files of the clients its grants name, in every office it may enter
 * (`PortalAccounts.offices`: live grant, active office and client, portal in the plan). Each office is read in its own
 * tenant context, filtered to the grant's client, and answers in portal-only shapes. Anything else — another client's
 * file, an unshared or unscanned document — is 404, as if it did not exist.
 */
@Injectable()
export class PortalService {
  constructor(
    private readonly accounts: PortalAccounts,
    private readonly tenants: TenantRunner,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly intake: ClientUploadIntake,
  ) {}

  async files(clientUserId: string): Promise<PortalFile[]> {
    const grants = await this.accounts.offices(clientUserId);
    const now = new Date();
    const lists = await Promise.all(
      grants.map(async (grant) => {
        const rows = await this.inOffice(grant, () =>
          this.prisma.db.legalFile.findMany({
            where: clientFiles(grant.clientId),
            orderBy: [{ openingDate: 'desc' }, { id: 'desc' }],
            take: MAX_FILES,
            select: fileSelect(now),
          }),
        );
        return rows.map((row) => toFile(grant, row));
      }),
    );
    // Two grants in one office (a person and their company) can both reach a file: list it once.
    const seen = new Set<string>();
    return lists.flat().filter((f) => !seen.has(f.id) && Boolean(seen.add(f.id)));
  }

  async file(clientUserId: string, fileId: string): Promise<PortalFileDetail> {
    return this.withFile(clientUserId, fileId, async (grant, row) => {
      const events = await this.prisma.db.caseTimelineEvent.findMany({
        where: { fileId, eventType: { in: [...PORTAL_TIMELINE_EVENT_TYPES] } },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: TIMELINE_EVENTS,
        select: { eventType: true, occurredAt: true },
      });
      return {
        ...toFile(grant, row),
        timeline: events.map((e) => ({
          eventType: e.eventType,
          occurredAt: e.occurredAt.toISOString(),
        })),
      };
    });
  }

  async documents(clientUserId: string, fileId: string): Promise<PortalDocument[]> {
    return this.withFile(clientUserId, fileId, async () => {
      const rows = await this.prisma.db.document.findMany({
        where: { fileId, deletedAt: null, sharedWithClient: true, status: OFFERED },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_DOCUMENTS,
        select: { id: true, name: true, mimeType: true, sizeBytes: true, createdAt: true },
      });
      return rows.map((r) => ({
        ...r,
        sizeBytes: r.sizeBytes.toString(),
        createdAt: r.createdAt.toISOString(),
      }));
    });
  }

  /** Receives a document from the client into the file's review queue (D-187); a file of no grant is 404, unread. */
  async upload(
    clientUserId: string,
    fileId: string,
    req: Request,
    client: ClientInfo,
  ): Promise<PortalUpload> {
    try {
      return await this.withFile(clientUserId, fileId, (grant) =>
        this.intake.receive(req, { fileId, clientId: grant.clientId, clientUserId }, client),
      );
    } catch (error) {
      if (error instanceof ResourceNotFoundException && !req.readableEnded) await discardBody(req);
      throw error;
    }
  }

  /** What this client sent on the file and where each stands; another client's uploads are never listed. */
  async uploads(clientUserId: string, fileId: string): Promise<PortalUpload[]> {
    return this.withFile(clientUserId, fileId, async (grant) => {
      const rows = await this.prisma.db.clientUpload.findMany({
        where: { fileId, clientId: grant.clientId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_DOCUMENTS,
      });
      return rows.map(toPortalUpload);
    });
  }

  /** A 5-minute link to a shared document's current version, audited as DOWNLOAD by the portal account. */
  async download(
    clientUserId: string,
    documentId: string,
    client: ClientInfo,
  ): Promise<DownloadLink> {
    for (const grant of await this.accounts.offices(clientUserId)) {
      const link = await this.inOffice(grant, async () => {
        const document = await this.prisma.db.document.findFirst({
          where: {
            id: documentId,
            deletedAt: null,
            sharedWithClient: true,
            status: OFFERED,
            file: clientFiles(grant.clientId),
          },
          select: { currentVersion: true },
        });
        if (!document) return null;
        const stored = await this.prisma.db.documentVersion.findFirstOrThrow({
          where: { documentId, versionNumber: document.currentVersion },
          select: { storageKey: true, originalFilename: true, mimeType: true },
        });
        const downloadUrl = await this.storage.presignedGetUrl(stored.storageKey, {
          expiresIn: DEFAULT_URL_TTL_SECONDS,
          filename: stored.originalFilename,
          contentType: stored.mimeType,
        });
        await this.prisma.db.auditLog.create({
          data: {
            ...auditRow(
              {
                officeId: grant.officeId,
                userId: null,
                entityType: 'Document',
                entityId: documentId,
                action: 'DOWNLOAD',
                newValues: { versionNumber: document.currentVersion, portal: true },
              },
              client,
            ),
            clientUserId,
          },
        });
        return { downloadUrl, expiresIn: DEFAULT_URL_TTL_SECONDS };
      });
      if (link) return link;
    }
    throw new ResourceNotFoundException();
  }

  /** Runs `work` in the office of the grant whose client the file belongs to, on the row read once; none → 404. */
  private async withFile<T>(
    clientUserId: string,
    fileId: string,
    work: (grant: PortalOfficeAccess, row: FileRow) => Promise<T>,
  ): Promise<T> {
    for (const grant of await this.accounts.offices(clientUserId)) {
      const result = await this.inOffice(grant, async () => {
        const row = await this.prisma.db.legalFile.findFirst({
          where: { id: fileId, ...clientFiles(grant.clientId) },
          select: fileSelect(new Date()),
        });
        return row ? { value: await work(grant, row) } : null;
      });
      if (result) return result.value;
    }
    throw new ResourceNotFoundException();
  }

  private inOffice<T>(grant: PortalOfficeAccess, work: () => Promise<T>): Promise<T> {
    return this.tenants.run({ officeId: grant.officeId as OfficeId }, work);
  }
}
