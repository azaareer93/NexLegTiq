import { ClsServiceManager } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';

import { AppConfig } from '../config/app-config';
import { testEnv } from '../config/env.fixture';
import { parseEnv } from '../config/env.schema';
import { ReadinessRegistry } from '../health/readiness.registry';
import { PrismaService } from './prisma.service';

function setup(): { prisma: PrismaService; registry: ReadinessRegistry } {
  const logger = { setContext: jest.fn(), warn: jest.fn() } as unknown as PinoLogger;
  const registry = new ReadinessRegistry(logger);
  const prisma = new PrismaService(new AppConfig(parseEnv(testEnv())), registry, ClsServiceManager.getClsService());
  return { prisma, registry };
}

describe('PrismaService', () => {
  it('should register a db readiness check that pings the database', async () => {
    const { prisma, registry } = setup();
    const ping = jest.spyOn(prisma.unscoped(), '$queryRaw').mockResolvedValue([{ '?column?': 1 }] as never);

    prisma.onModuleInit();

    expect(registry.names()).toEqual(['db']);
    await expect(registry.run()).resolves.toMatchObject({ status: 'ok', checks: { db: { status: 'up' } } });
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('should report db down when the ping fails', async () => {
    const { prisma, registry } = setup();
    jest.spyOn(prisma.unscoped(), '$queryRaw').mockRejectedValue(new Error('ECONNREFUSED'));

    prisma.onModuleInit();

    await expect(registry.run()).resolves.toMatchObject({ status: 'error', checks: { db: { status: 'down' } } });
  });

  it('should disconnect on shutdown', async () => {
    const { prisma } = setup();
    const disconnect = jest.spyOn(prisma.unscoped(), '$disconnect').mockResolvedValue();

    await prisma.onModuleDestroy();

    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('should expose a tenant-scoped client that refuses tenant queries without an office', async () => {
    const { prisma } = setup();

    await expect(prisma.db.user.findMany()).rejects.toThrow('No officeId in the request context for User.findMany');
  });
});
