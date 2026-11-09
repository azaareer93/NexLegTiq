import { DashboardDeadlineSchema, DashboardSchema } from './dashboard.contract.js';

const FILE = { id: '01920000-0000-7000-8000-000000000001', fileNumber: 'F-1', title: 'Rent' };

describe('DashboardSchema (D-151)', () => {
  it('should read hearings and tasks as deadlines, and refuse a task with a time', () => {
    expect(
      DashboardDeadlineSchema.parse({
        kind: 'HEARING',
        id: FILE.id,
        file: FILE,
        sessionType: 'HEARING',
        startsAt: '2026-11-09T08:00:00.000Z',
      }).kind,
    ).toBe('HEARING');
    expect(
      DashboardDeadlineSchema.safeParse({
        kind: 'TASK',
        id: FILE.id,
        title: 'Reply',
        dueDate: '2026-11-09T08:00:00.000Z',
        file: null,
      }).success,
    ).toBe(false);
  });

  it('should take a dashboard without the office cards', () => {
    const parsed = DashboardSchema.parse({
      today: '2026-11-09',
      openFiles: { count: 0, openedThisWeek: 0 },
      todayHearings: [],
      nextHearingId: null,
      overdueTasks: 0,
      newDocuments: 0,
      newClientsThisMonth: null,
      deadlines: [],
      activity: { items: [], names: {} },
      team: null,
    });
    expect(parsed.team).toBeNull();
  });
});
