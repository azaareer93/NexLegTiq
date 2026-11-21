import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import { ProductAnalytics } from './product-analytics';
import type { PrismaService } from '../../database/prisma.service';
import type { RequestContext } from '../context/request-context';

const OFFICE = '01920000-0000-7000-8000-00000000000a';

function setup(
  options: { context?: Partial<RequestContext>; enabled?: boolean | null; files?: number } = {},
) {
  const context: Partial<RequestContext> = { officeId: OFFICE as never, ...options.context };
  const raw = {
    officeSettings: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          options.enabled === null ? null : { enableProductAnalytics: options.enabled ?? true },
        ),
    },
    productEvent: {
      create: jest.fn().mockResolvedValue({ id: 'e1' }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    office: {
      findUnique: jest.fn().mockResolvedValue({ createdAt: new Date(Date.now() - 90_000) }),
    },
    legalFile: { count: jest.fn().mockResolvedValue(options.files ?? 1) },
  };
  const logger = { setContext: jest.fn(), warn: jest.fn() };
  const analytics = new ProductAnalytics(
    { unscoped: () => raw } as unknown as PrismaService,
    { get: (key: keyof RequestContext) => context[key] } as unknown as ClsService<RequestContext>,
    logger as unknown as PinoLogger,
  );
  return { analytics, raw, logger };
}

describe('ProductAnalytics (D-215)', () => {
  it('should record the event with the office id and the allow-listed props only', async () => {
    const { analytics, raw } = setup();
    await analytics.track('ONBOARDING_STEP_COMPLETED', { step: 'CASE' });
    expect(raw.productEvent.create).toHaveBeenCalledWith({
      data: { officeId: OFFICE, event: 'ONBOARDING_STEP_COMPLETED', props: { step: 'CASE' } },
      select: { id: true },
    });
  });

  it('should refuse props outside the allow-list without failing the caller', async () => {
    const { analytics, raw, logger } = setup();
    await expect(
      analytics.track('INVITE_SENT', { email: 'a@example.test' } as never),
    ).resolves.toBeUndefined();
    expect(raw.productEvent.create).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it.each([
    ['Do Not Track / GPC', { context: { doNotTrack: true } }],
    ['an office that opted out', { enabled: false }],
  ])('should record nothing for %s', async (_label, options) => {
    const { analytics, raw } = setup(options);
    await analytics.track('SIGNUP_COMPLETED', {});
    await analytics.active(OFFICE);
    expect(raw.productEvent.create).not.toHaveBeenCalled();
  });

  it('should take an explicit office where no tenant context exists (signup)', async () => {
    const { analytics, raw } = setup({ context: { officeId: undefined } });
    await analytics.track('SIGNUP_COMPLETED', {});
    expect(raw.productEvent.create).not.toHaveBeenCalled();
    await analytics.track('SIGNUP_COMPLETED', {}, 'other-office');
    expect(raw.productEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ officeId: 'other-office' }) }),
    );
  });

  it('should never fail the caller when the database does', async () => {
    const { analytics, raw } = setup();
    raw.productEvent.create.mockRejectedValueOnce(new Error('down'));
    await expect(analytics.track('HEARING_SCHEDULED', {})).resolves.toBeUndefined();
  });

  it("should record the office's first case with the seconds since signup, and no later one", async () => {
    const first = setup();
    await first.analytics.firstCase();
    const data = (first.raw.productEvent.create.mock.calls[0]?.[0] as { data: { props: object } })
      .data;
    expect(data).toMatchObject({ event: 'FIRST_CASE_CREATED' });
    expect(data.props).toEqual({ secondsSinceSignup: expect.any(Number) });
    expect(
      (data.props as { secondsSinceSignup: number }).secondsSinceSignup,
    ).toBeGreaterThanOrEqual(90);

    const second = setup({ files: 2 });
    await second.analytics.firstCase();
    expect(second.raw.productEvent.create).not.toHaveBeenCalled();
  });

  it('should record activity once per office and UTC day', async () => {
    const { analytics, raw } = setup();
    const morning = new Date('2026-11-21T08:00:00Z');
    await analytics.active(OFFICE, morning);
    await analytics.active(OFFICE, new Date('2026-11-21T20:00:00Z'));
    expect(raw.productEvent.findFirst).toHaveBeenCalledTimes(1);
    expect(raw.productEvent.create).toHaveBeenCalledTimes(1);

    raw.productEvent.findFirst.mockResolvedValueOnce({ id: 'seen' });
    await analytics.active(OFFICE, new Date('2026-11-22T08:00:00Z'));
    expect(raw.productEvent.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ createdAt: { gte: new Date('2026-11-22T00:00:00Z') } }),
      }),
    );
    expect(raw.productEvent.create).toHaveBeenCalledTimes(1);
  });
});
