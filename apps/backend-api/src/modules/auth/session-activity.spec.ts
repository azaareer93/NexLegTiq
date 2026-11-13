import type { PinoLogger } from 'nestjs-pino';

import type { RefreshTokenRepository } from './refresh-token.repository';
import { ACTIVITY_WRITE_MS, SessionActivity } from './session-activity';

function setup() {
  const touch = jest.fn().mockResolvedValue(undefined);
  const logger = { setContext: jest.fn(), warn: jest.fn() };
  const activity = new SessionActivity(
    { touch } as unknown as RefreshTokenRepository,
    logger as unknown as PinoLogger,
  );
  return { activity, touch, logger };
}

describe('SessionActivity (MVP-168)', () => {
  it('should write a session at most once a minute, each session on its own', async () => {
    const { activity, touch } = setup();
    const at = new Date('2026-11-13T10:00:00Z');
    await activity.touch('o1', 'f1', at);
    await activity.touch('o1', 'f1', new Date(at.getTime() + ACTIVITY_WRITE_MS - 1));
    await activity.touch('o1', 'f2', at);
    expect(touch).toHaveBeenCalledTimes(2);
    expect(touch).toHaveBeenCalledWith('o1', 'f1', at, ACTIVITY_WRITE_MS);
    await activity.touch('o1', 'f1', new Date(at.getTime() + ACTIVITY_WRITE_MS));
    expect(touch).toHaveBeenCalledTimes(3);
  });

  it('should log a failed write and never fail the request', async () => {
    const { activity, touch, logger } = setup();
    touch.mockRejectedValueOnce(new Error('db down'));
    await expect(activity.touch('o1', 'f1')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});
