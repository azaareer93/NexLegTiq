import { Injectable } from '@nestjs/common';
import type {
  DownloadLink,
  PortalOfficeAccess,
  PortalDocument,
  PortalFile,
  PortalFileDetail,
} from '@nexlegtiq/shared-contracts';
import { PORTAL_TIMELINE_EVENT_TYPES } from '@nexlegtiq/shared-types';
import type { OfficeId } from '@nexlegtiq/shared-types';

import { auditRow } from '../../common/audit/audit.service';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { DEFAULT_URL_TTL_SECONDS, StorageService } from '../../common/storage/storage.service';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { ClientInfo } from '../auth/client-info';
import { PortalAccounts } from '../portal-auth/portal-accounts';

/** shortcut: no paging — a client has few files; page when one passes this. */
const MAX_FILES = 200;
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
  ) {}

  async files(clientUserId: string): Promise<PortalFile[]> {
    const grants = await this.accounts.offices(clientUserId);
    const now = new Date();
    const lists = await Promise.all(
      grants.map((grant) =>
        this.inOffice(grant, () =>
          this.prisma.db.legalFile.findMany({
            where: clientFiles(grant.clientId),
            orderBy: [{ openingDate: 'desc' }, { id: 'desc' }],
            take: MAX_FILES,
            select: fileSelect(now),
          }),
        ),
      ),
    );
    return lists.flatMap((rows, i) =>
      rows.map((row) => toFile(grants[i] as PortalOfficeAccess, row)),
    );
  }

  async file(clientUserId: string, fileId: string): Promise<PortalFileDetail> {
    return this.withFile(clientUserId, fileId, async (grant) => {
      const row = await this.prisma.db.legalFile.findFirstOrThrow({
        where: { id: fileId },
        select: fileSelect(new Date()),
      });
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
        select: { id: true, name: true, mimeType: true, sizeBytes: true, createdAt: true },
      });
      return rows.map((r) => ({
        ...r,
        sizeBytes: r.sizeBytes.toString(),
        createdAt: r.createdAt.toISOString(),
      }));
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

  /** Runs `work` in the office of the grant whose client the file belongs to; none → 404. */
  private async withFile<T>(
    clientUserId: string,
    fileId: string,
    work: (grant: PortalOfficeAccess) => Promise<T>,
  ): Promise<T> {
    for (const grant of await this.accounts.offices(clientUserId)) {
      const found = await this.inOffice(grant, () =>
        this.prisma.db.legalFile.count({ where: { id: fileId, ...clientFiles(grant.clientId) } }),
      );
      if (found > 0) return this.inOffice(grant, () => work(grant));
    }
    throw new ResourceNotFoundException();
  }

  private inOffice<T>(grant: PortalOfficeAccess, work: () => Promise<T>): Promise<T> {
    return this.tenants.run({ officeId: grant.officeId as OfficeId }, work);
  }
}
