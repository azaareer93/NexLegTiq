import { daysAgo, isAtRisk } from './office-activity';

describe('isAtRisk (D-164)', () => {
  const now = new Date('2026-11-13T12:00:00Z');
  const old = daysAgo(60, now);

  it('should flag an old active office without a write in 14 days, or without any write', () => {
    expect(isAtRisk({ isActive: true, createdAt: old, lastWriteAt: daysAgo(15, now) }, now)).toBe(
      true,
    );
    expect(isAtRisk({ isActive: true, createdAt: old, lastWriteAt: null }, now)).toBe(true);
  });

  it('should not flag a recent write, a new office or a suspended one', () => {
    expect(isAtRisk({ isActive: true, createdAt: old, lastWriteAt: daysAgo(13, now) }, now)).toBe(
      false,
    );
    expect(isAtRisk({ isActive: true, createdAt: daysAgo(10, now), lastWriteAt: null }, now)).toBe(
      false,
    );
    expect(isAtRisk({ isActive: false, createdAt: old, lastWriteAt: null }, now)).toBe(false);
  });
});
