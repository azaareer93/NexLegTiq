import {
  CreateTimeEntrySchema,
  HoursSchema,
  TimeEntryQuerySchema,
  UpdateTimeEntrySchema,
} from './time-entry.contract.js';

describe('time entry contracts (D-152)', () => {
  it('should take hours in (0, 24] with two decimals at most', () => {
    for (const ok of ['0.01', '1', '1.5', '24', ' 7.25 '])
      expect(HoursSchema.safeParse(ok).success).toBe(true);
    for (const bad of ['0', '0.00', '24.01', '1.234', '-1', '1e1', 'abc', '100']) {
      expect(HoursSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('should default an entry to billable and read query flags as booleans', () => {
    const entry = CreateTimeEntrySchema.parse({
      fileId: '01920000-0000-7000-8000-000000000001',
      durationHours: '1',
      description: 'Call',
    });
    expect(entry.isBillable).toBe(true);
    expect(TimeEntryQuerySchema.parse({ billable: 'false', invoiced: 'true' })).toMatchObject({
      billable: false,
      invoiced: true,
      page: 1,
      limit: 20,
    });
    expect(UpdateTimeEntrySchema.safeParse({ description: '' }).success).toBe(false);
  });
});
