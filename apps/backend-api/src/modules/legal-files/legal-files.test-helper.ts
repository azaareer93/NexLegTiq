import { randomUUID } from 'node:crypto';

import type { OfficeId } from '@nexlegtiq/shared-types';
import { ClsServiceManager } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import type { RequestContext } from '../../common/context/request-context';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';
import { PrismaService } from '../../database/prisma.service';
import { TENANT_MODELS } from '../../database/tenant-models';
import type { PrismaClient } from '../../generated/prisma/client';
import { ReadinessRegistry } from '../../health/readiness.registry';

export interface TestOffice {
  readonly officeId: string;
  readonly userId: string;
}

type Delegate = { deleteMany(args: unknown): Promise<unknown> };

/** Real-PostgreSQL fixtures for the legal-file integration specs: offices with a lawyer, cleaned up afterwards. */
export class LegalFilesTestDb {
  readonly cls = ClsServiceManager.getClsService<RequestContext>();
  readonly runner = new TenantRunner(this.cls);
  readonly prisma: PrismaService;
  readonly raw: PrismaClient;
  private readonly officeIds: string[] = [];

  constructor() {
    const config = new AppConfig(
      parseEnv(testEnv({ DATABASE_URL: process.env['DATABASE_URL'], NODE_ENV: 'test' })),
    );
    this.prisma = new PrismaService(
      config,
      new ReadinessRegistry({ setContext: () => undefined } as unknown as PinoLogger),
      this.cls,
    );
    // unscoped: test fixtures create offices and check constraints across them.
    this.raw = this.prisma.unscoped();
  }

  async newOffice(fileNumberFormat?: string): Promise<TestOffice> {
    const office = await this.raw.office.create({
      data: { name: 'Legal files test', settings: { create: { fileNumberFormat } } },
    });
    this.officeIds.push(office.id);
    const user = await this.raw.user.create({
      data: {
        officeId: office.id,
        fullName: 'Lawyer',
        email: `legal-files-${office.id}@example.test`,
        passwordHash: '!',
        role: 'LAWYER',
      },
    });
    return { officeId: office.id, userId: user.id };
  }

  newUser(office: TestOffice) {
    return this.raw.user.create({
      data: {
        officeId: office.officeId,
        fullName: 'Colleague',
        email: `legal-files-${randomUUID()}@example.test`,
        passwordHash: '!',
        role: 'LAWYER',
      },
    });
  }

  asOffice<T>(office: TestOffice, work: () => Promise<T>): Promise<T> {
    return this.runner.run({ officeId: office.officeId as OfficeId }, work);
  }

  fileData(office: TestOffice, fileNumber: string) {
    return {
      officeId: office.officeId,
      fileNumber,
      title: 'Test file',
      fileType: 'LITIGATION' as const,
      responsibleLawyerId: office.userId,
      jurisdiction: 'PALESTINE' as const,
      currency: 'ILS',
    };
  }

  /** Children first (TENANT_MODELS lists parents first), users, then the offices. */
  async cleanUp(): Promise<void> {
    const where = { officeId: { in: this.officeIds } };
    for (const model of [...TENANT_MODELS].filter((name) => name !== 'User').reverse()) {
      const delegate = (this.raw as unknown as Record<string, Delegate>)[
        model.charAt(0).toLowerCase() + model.slice(1)
      ];
      await delegate?.deleteMany({ where });
    }
    await this.raw.user.deleteMany({ where });
    await this.raw.office.deleteMany({ where: { id: { in: this.officeIds } } });
    await this.prisma.onModuleDestroy();
  }
}
