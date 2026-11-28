import { Injectable } from '@nestjs/common';
import type {
  AddReportedCourtRequest,
  AdminCourtReport,
  AdminCourtReportQuery,
  DismissCourtReportRequest,
} from '@nexlegtiq/shared-contracts';
import type { OfficeId } from '@nexlegtiq/shared-types';
import { PinoLogger } from 'nestjs-pino';

import { COURT_SELECT } from './courts.service';
import type { ClientInfo } from '../../common/context/client-info';
import {
  BusinessRuleException,
  ResourceNotFoundException,
} from '../../common/errors/app.exception';
import { PaginatedResult } from '../../common/http/paginated-result';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { NotificationService } from '../notifications/notification.service';
import { PlatformAuditService } from '../platform-auth/platform-audit.service';

type Tx = Prisma.TransactionClient;
type ResolvedReport = AdminCourtReport & { reportedById: string };

/** The response: who reported it is shown by name only. */
const toPublic = ({ reportedById, ...dto }: ResolvedReport): AdminCourtReport => dto;

const REPORT_SELECT = {
  id: true,
  officeId: true,
  name: true,
  city: true,
  note: true,
  status: true,
  courtId: true,
  dismissReason: true,
  resolvedAt: true,
  createdAt: true,
  reportedById: true,
  office: { select: { name: true, jurisdiction: true } },
  reportedBy: { select: { fullName: true } },
} satisfies Prisma.CourtReportSelect;
type ReportRow = Prisma.CourtReportGetPayload<{ select: typeof REPORT_SELECT }>;

const toDto = ({ office, reportedBy, reportedById, ...row }: ReportRow): AdminCourtReport => ({
  ...row,
  officeName: office.name,
  jurisdiction: office.jurisdiction,
  reportedByName: reportedBy.fullName,
  resolvedAt: row.resolvedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Courts offices reported missing (MVP-167, D-266), for the platform admin: add the court (a new platform court in the
 * office's country) or dismiss the report, once (422 BIZ-029); the reporting user is then notified in-app.
 * unscoped: reports of every office, read and resolved only by the platform admin (D-080).
 */
@Injectable()
export class PlatformCourtReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: PlatformAuditService,
    private readonly tenant: TenantRunner,
    private readonly notifications: NotificationService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PlatformCourtReportsService.name);
  }

  async list(query: AdminCourtReportQuery): Promise<PaginatedResult<AdminCourtReport>> {
    const where: Prisma.CourtReportWhereInput = query.status ? { status: query.status } : {};
    // unscoped: see the class comment.
    const db = this.prisma.unscoped();
    const [rows, total] = await Promise.all([
      db.courtReport.findMany({
        where,
        select: REPORT_SELECT,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.courtReport.count({ where }),
    ]);
    return PaginatedResult.of(rows.map(toDto), { page: query.page, limit: query.limit, total });
  }

  /** Creates the platform court (409 RES-002 if the country has one by that English name) and links it. */
  async add(
    id: string,
    body: AddReportedCourtRequest,
    adminId: string,
    client: ClientInfo,
  ): Promise<AdminCourtReport> {
    const report = await this.resolve(id, adminId, client, async (tx, pending) => {
      const court = await tx.court.create({
        data: { ...body, jurisdiction: pending.office.jurisdiction },
        select: COURT_SELECT,
      });
      const newValues = { status: 'ADDED', courtId: court.id, ...body };
      return {
        data: { status: 'ADDED', courtId: court.id },
        action: 'COURT_REPORT_ADDED',
        newValues,
      };
    });
    await this.notify(report, 'common.notifications.courtReportAdded');
    return toPublic(report);
  }

  async dismiss(
    id: string,
    body: DismissCourtReportRequest,
    adminId: string,
    client: ClientInfo,
  ): Promise<AdminCourtReport> {
    const dismissReason = body.reason ?? null;
    const report = await this.resolve(id, adminId, client, async () => ({
      data: { status: 'DISMISSED', dismissReason },
      action: 'COURT_REPORT_DISMISSED',
      newValues: { status: 'DISMISSED', dismissReason },
    }));
    await this.notify(report, 'common.notifications.courtReportDismissed');
    return toPublic(report);
  }

  /** One transaction: the pending report locked (else 404 / 422 BIZ-029), the change, its audit row. */
  private async resolve(
    id: string,
    adminId: string,
    client: ClientInfo,
    change: (
      tx: Tx,
      pending: ReportRow,
    ) => Promise<{
      data: Prisma.CourtReportUncheckedUpdateInput;
      action: string;
      newValues: Record<string, unknown>;
    }>,
  ): Promise<ResolvedReport> {
    // unscoped: see the class comment.
    return this.prisma.unscoped().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM court_reports WHERE id = ${id}::uuid FOR UPDATE`;
      const pending = await tx.courtReport.findUnique({ where: { id }, select: REPORT_SELECT });
      if (!pending) throw new ResourceNotFoundException();
      if (pending.status !== 'PENDING') {
        throw new BusinessRuleException('BIZ-029', 'The court report was already resolved');
      }
      const { data, action, newValues } = await change(tx, pending);
      const row = await tx.courtReport.update({
        where: { id },
        data: { ...data, resolvedById: adminId, resolvedAt: new Date() },
        select: REPORT_SELECT,
      });
      await this.audit.log(
        {
          adminId,
          action,
          entityType: 'CourtReport',
          entityId: id,
          targetOfficeId: pending.officeId,
          oldValues: { status: 'PENDING' },
          // Names, ids and the reason: plain JSON values.
          newValues: newValues as Prisma.InputJsonObject,
        },
        client,
        tx,
      );
      return { ...toDto(row), reportedById: row.reportedById };
    });
  }

  /**
   * After the commit, in the office's tenant context (the fan-out job runs for that office, D-149). A failed enqueue
   * does not undo the resolution: it is logged and the admin's answer stands.
   */
  private async notify(report: ResolvedReport, titleKey: string): Promise<void> {
    try {
      await this.tenant.run({ officeId: report.officeId as OfficeId }, () =>
        this.notifications.notify(
          [report.reportedById],
          {
            type: 'COURT_REPORT_RESOLVED',
            titleKey,
            params: { name: report.name, reason: report.dismissReason },
            link: null,
          },
          { jobId: `court-report-${report.id}` },
        ),
      );
    } catch (error) {
      this.logger.error({ err: error, reportId: report.id }, 'Court report notification failed');
    }
  }
}
