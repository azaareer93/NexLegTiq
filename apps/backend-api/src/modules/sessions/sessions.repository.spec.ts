import { SessionsRepository, toReminder } from './sessions.repository';
import type { PrismaService } from '../../database/prisma.service';

const AT = new Date('2026-11-02T07:30:00Z');

const row = (overrides: object = {}) => ({
  id: 's1',
  sessionType: 'HEARING',
  startsAt: AT,
  endsAt: null,
  courtRoom: null,
  reminderDays: [3],
  outcome: null,
  nextSessionId: null,
  isCancelled: false,
  cancellationReason: null,
  createdAt: AT,
  updatedAt: AT,
  file: { id: 'f1', fileNumber: '2026-LIT-00001', title: 'T' },
  court: null,
  judge: null,
  attendingLawyer: { id: 'u1', fullName: 'L' },
  previousSession: null,
  ...overrides,
});

describe('SessionsRepository mapping', () => {
  it('should map list rows with and without optional instants and a previous session', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([
        row(),
        row({ endsAt: AT, previousSession: { id: 'p1' }, isCancelled: true }),
      ]);
    const repo = new SessionsRepository({
      db: { session: { findMany } },
    } as unknown as PrismaService);
    const [plain, full] = await repo.findMany({}, [], { skip: 0, take: 10 });
    expect(plain).toMatchObject({ endsAt: null, previousSessionId: null, status: 'SCHEDULED' });
    expect(full).toMatchObject({
      endsAt: AT.toISOString(),
      previousSessionId: 'p1',
      status: 'CANCELLED',
    });
    expect(full).not.toHaveProperty('isCancelled');
  });

  it('should map a detail with its minutes and reminders', async () => {
    const findFirstOrThrow = jest.fn().mockResolvedValue({
      ...row({ outcome: 'ADJOURNED' }),
      minutes: 'm',
      reminders: [
        {
          id: 'r1',
          daysBefore: 3,
          scheduledFor: AT,
          status: 'SENT',
          recipient: { id: 'u1', fullName: 'L' },
          sentAt: AT,
          acknowledgedAt: null,
        },
      ],
    });
    const repo = new SessionsRepository({
      db: { session: { findFirstOrThrow } },
    } as unknown as PrismaService);
    await expect(repo.get('s1')).resolves.toMatchObject({
      status: 'COMPLETED',
      minutes: 'm',
      reminders: [{ sentAt: AT.toISOString(), acknowledgedAt: null }],
    });
  });

  it('should write a pending reminder with no sent or acknowledged time', () => {
    expect(
      toReminder({
        id: 'r',
        daysBefore: 1,
        scheduledFor: AT,
        status: 'PENDING',
        recipient: { id: 'u', fullName: 'L' },
        sentAt: null,
        acknowledgedAt: AT,
      } as never),
    ).toMatchObject({ sentAt: null, acknowledgedAt: AT.toISOString() });
  });
});
