import type { PinoLogger } from 'nestjs-pino';

import { AiCostAlert } from './ai-cost-alert';
import type { MailTransport } from '../../common/mail/mail-transport';
import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';
import type { PrismaService } from '../../database/prisma.service';

function setup(sum: string | null, alert: Record<string, string> = {}) {
  const aggregate = jest.fn().mockResolvedValue({ _sum: { costUsd: sum } });
  const prisma = { unscoped: () => ({ aiUsage: { aggregate } }) } as unknown as PrismaService;
  const transport = { send: jest.fn().mockResolvedValue(undefined) };
  const logger = { setContext: jest.fn(), error: jest.fn() };
  const config = new AppConfig(parseEnv(testEnv(alert)));
  const service = new AiCostAlert(
    prisma,
    config,
    transport as unknown as MailTransport,
    logger as unknown as PinoLogger,
  );
  return { service, aggregate, transport, logger };
}

const ON = { AI_COST_ALERT_THRESHOLD_USD: '20', AI_COST_ALERT_EMAIL: 'founder@example.com' };
const NOW = new Date('2026-10-26T06:00:00Z');

describe('AiCostAlert (D-144)', () => {
  it('should do nothing while no alert is configured', async () => {
    const { service, aggregate } = setup('99');
    await expect(service.run(NOW)).resolves.toBeNull();
    expect(aggregate).not.toHaveBeenCalled();
  });

  it("should sum the previous UTC day's cost of every office and stay quiet at or under the threshold", async () => {
    const { service, aggregate, transport } = setup('20.000000', ON);
    await expect(service.run(NOW)).resolves.toEqual({
      day: '2026-10-25',
      costUsd: '20.00',
      alerted: false,
    });
    expect(aggregate).toHaveBeenCalledWith({
      where: {
        createdAt: { gte: new Date('2026-10-25T00:00:00Z'), lt: new Date('2026-10-26T00:00:00Z') },
      },
      _sum: { costUsd: true },
    });
    expect(transport.send).not.toHaveBeenCalled();
    await expect(setup(null, ON).service.run(NOW)).resolves.toMatchObject({ costUsd: '0.00' });
  });

  it('should email the founder and log an error above the threshold', async () => {
    const { service, transport, logger } = setup('20.004500', ON);
    await expect(service.run(NOW)).resolves.toMatchObject({ costUsd: '20.00', alerted: true });
    expect(transport.send).toHaveBeenCalledWith(
      'founder@example.com',
      expect.objectContaining({ subject: 'AI cost alert: 20.00 USD on 2026-10-25' }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      { day: '2026-10-25', costUsd: '20.00', thresholdUsd: '20.00' },
      'AI cost above the daily threshold',
    );
  });

  it('should be configured as a pair', () => {
    expect(() => parseEnv(testEnv({ AI_COST_ALERT_THRESHOLD_USD: '20' }))).toThrow(/set together/);
    expect(() =>
      parseEnv(testEnv({ AI_COST_ALERT_THRESHOLD_USD: '0', AI_COST_ALERT_EMAIL: 'a@b.co' })),
    ).toThrow();
  });
});
