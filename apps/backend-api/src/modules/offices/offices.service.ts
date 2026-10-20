import { Injectable } from '@nestjs/common';
import type {
  OfficeProfile,
  OfficeSettings,
  UpdateOfficeProfileRequest,
  UpdateOfficeSettingsRequest,
} from '@nexlegtiq/shared-contracts';
import { ClsService } from 'nestjs-cls';

import type { RequestContext } from '../../common/context/request-context';
import { ValidationException } from '../../common/errors/app.exception';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { ScopedTransaction } from '../../database/unit-of-work';
import { Prisma } from '../../generated/prisma/client';
import type { ClientInfo } from '../auth/client-info';
import { truncateUserAgent } from '../auth/client-info';
import { parseFileNumberFormat } from '../legal-files/file-number';

const PROFILE = {
  id: true,
  name: true,
  registrationNumber: true,
  taxId: true,
  phone: true,
  email: true,
  address: true,
  website: true,
  jurisdiction: true,
  accountType: true,
  defaultLanguage: true,
  currency: true,
  timezone: true,
} as const satisfies Prisma.OfficeSelect;

const SETTINGS = {
  id: true,
  courtReminderDays: true,
  taskReminderDays: true,
  defaultBillingRate: true,
  defaultBillingMethod: true,
  taxRatePercent: true,
  enableAi: true,
  enableOcr: true,
  fileNumberFormat: true,
  sessionIdleMinutes: true,
  auditRetentionDays: true,
} as const satisfies Prisma.OfficeSettingsSelect;

/**
 * The current office's profile and settings (MVP-48, W4, D-125). Read on every write that uses them (new files, sessions,
 * reminders), so a change applies to the next one; nothing caches them. Writes record only the fields that changed.
 */
@Injectable()
export class OfficesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  profile(): Promise<OfficeProfile> {
    return this.prisma.db.office.findFirstOrThrow({ select: PROFILE });
  }

  async settings(): Promise<OfficeSettings> {
    return presentSettings(await settingsRow(this.prisma.db));
  }

  async updateProfile(
    input: UpdateOfficeProfileRequest,
    client: ClientInfo,
  ): Promise<OfficeProfile> {
    await this.uow.run(async (tx) => {
      await this.lock(tx);
      const before = await tx.office.findFirstOrThrow({ select: PROFILE });
      const { old, next } = changes(before, input);
      if (Object.keys(next).length === 0) return;
      await tx.office.update({ where: { id: before.id }, data: next });
      await tx.auditLog.create({ data: this.audit(client, 'Office', before.id, old, next) });
    });
    return this.profile();
  }

  async updateSettings(
    input: UpdateOfficeSettingsRequest,
    client: ClientInfo,
  ): Promise<OfficeSettings> {
    // The contract checks the format's shape; the parser that numbers files has the last word.
    if (input.fileNumberFormat !== undefined) assertFileNumberFormat(input.fileNumberFormat);
    await this.uow.run(async (tx) => {
      await this.lock(tx);
      const before = await settingsRow(tx);
      const { old, next } = changes(before, input);
      if (Object.keys(next).length === 0) return;
      await tx.officeSettings.update({ where: { id: before.id }, data: next });
      await tx.auditLog.create({
        data: this.audit(client, 'OfficeSettings', before.id, old, next),
      });
    });
    return this.settings();
  }

  /** Concurrent edits queue, so every audit row's old values are what the edit really replaced. */
  private async lock(tx: ScopedTransaction): Promise<void> {
    await tx.$queryRaw`SELECT 1 FROM offices WHERE id = ${this.officeId()}::uuid FOR UPDATE`;
  }

  private audit(
    client: ClientInfo,
    entityType: 'Office' | 'OfficeSettings',
    entityId: string,
    oldValues: object,
    newValues: object,
  ) {
    return {
      officeId: this.officeId(),
      userId: this.actorId(),
      entityType,
      entityId,
      action: 'UPDATE' as const,
      oldValues,
      newValues,
      ipAddress: client.ip,
      userAgent: truncateUserAgent(client.userAgent),
      requestId: client.requestId,
    };
  }

  private actorId(): string {
    const userId = this.cls.get('userId');
    if (!userId) throw new Error('No user in the request context');
    return userId;
  }

  private officeId(): string {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the request context');
    return officeId;
  }
}

/** Signup always creates the row (D-083): a missing one is a deployment fault (500), not a 404. */
async function settingsRow(db: Pick<ScopedTransaction, 'officeSettings'>) {
  const row = await db.officeSettings.findFirst({ select: SETTINGS });
  if (!row) throw new Error('Office settings row is missing');
  return row;
}

function presentSettings({
  id: _id,
  ...row
}: Awaited<ReturnType<typeof settingsRow>>): OfficeSettings {
  return {
    ...row,
    defaultBillingRate: row.defaultBillingRate?.toFixed(2) ?? null,
    taxRatePercent: row.taxRatePercent.toFixed(2),
  };
}

function assertFileNumberFormat(format: string): void {
  try {
    parseFileNumberFormat(format);
  } catch {
    throw new ValidationException([
      { field: 'fileNumberFormat', message: 'validation.fileNumberFormat' },
    ]);
  }
}

/** Fields of `data` whose value differs from `before`: decimals compare as numbers, arrays by their items. */
export function changes(before: Record<string, unknown>, data: Record<string, unknown>) {
  const old: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    const previous = before[key];
    const decimal = Prisma.Decimal.isDecimal(previous) ? previous : null;
    const same = decimal
      ? value !== null && decimal.equals(value as string)
      : JSON.stringify(previous) === JSON.stringify(value);
    if (!same) {
      old[key] = decimal ? decimal.toFixed(2) : previous;
      next[key] = value;
    }
  }
  return { old, next };
}
