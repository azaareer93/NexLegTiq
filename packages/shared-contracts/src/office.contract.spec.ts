import { CurrencySchema, TimeZoneSchema } from './fields.js';
import { UpdateOfficeProfileSchema, UpdateOfficeSettingsSchema } from './office.contract.js';

const messages = (result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}) =>
  result.success
    ? []
    : (result.error?.issues ?? []).map((i) => `${i.path.join('.')}: ${i.message}`);

describe('office contracts (D-125)', () => {
  it('should clear empty optional profile fields and normalise currency and email', () => {
    expect(
      UpdateOfficeProfileSchema.parse({
        website: ' ',
        taxId: null,
        email: ' A@B.TEST ',
        currency: 'jod',
        timezone: 'Asia/Amman',
      }),
    ).toEqual({
      website: null,
      taxId: null,
      email: 'a@b.test',
      currency: 'JOD',
      timezone: 'Asia/Amman',
    });
    expect(UpdateOfficeProfileSchema.parse({})).toEqual({});
  });

  it('should refuse bad profile values with their keys', () => {
    expect(
      messages(
        UpdateOfficeProfileSchema.safeParse({
          website: 'ftp://x.test',
          timezone: 'Nowhere/City',
          currency: 'ABC',
          name: '',
        }),
      ).sort(),
    ).toEqual([
      'currency: validation.currency',
      'name: validation.required',
      'timezone: validation.timeZone',
      'website: validation.website',
    ]);
    expect(TimeZoneSchema.safeParse('').success).toBe(false);
    for (const zone of ['+02:00', 'Etc/GMT+2', '-0130']) {
      expect(TimeZoneSchema.safeParse(zone).success).toBe(false);
    }
    expect(TimeZoneSchema.parse('asia/hebron')).toBe('Asia/Hebron');
    expect(TimeZoneSchema.parse('UTC')).toBe('UTC');
    expect(
      UpdateOfficeProfileSchema.safeParse({ website: 'https://x.test/‮gpj' }).error?.issues[0]
        ?.message,
    ).toBe('validation.invalidCharacters');
    expect(CurrencySchema.safeParse('usd').data).toBe('USD');
  });

  it('should sort reminder days largest first and refuse duplicates, empties and out-of-range days', () => {
    expect(
      UpdateOfficeSettingsSchema.parse({ courtReminderDays: [1, 14, 3], taskReminderDays: [] }),
    ).toEqual({ courtReminderDays: [14, 3, 1], taskReminderDays: [] });
    expect(UpdateOfficeSettingsSchema.parse({ taskReminderDays: [0] })).toEqual({
      taskReminderDays: [0],
    });
    expect(messages(UpdateOfficeSettingsSchema.safeParse({ courtReminderDays: [2, 2] }))).toEqual([
      'courtReminderDays: validation.duplicate',
    ]);
    expect(messages(UpdateOfficeSettingsSchema.safeParse({ courtReminderDays: [] }))).toEqual([
      'courtReminderDays: validation.required',
    ]);
    expect(messages(UpdateOfficeSettingsSchema.safeParse({ courtReminderDays: [0, 31] }))).toEqual([
      'courtReminderDays.0: validation.reminderRange',
      'courtReminderDays.1: validation.reminderRange',
    ]);
  });

  it.each([
    [{ taxRatePercent: '100.01' }, 'taxRatePercent: validation.percent'],
    [{ taxRatePercent: '1.234' }, 'taxRatePercent: validation.percent'],
    [{ sessionIdleMinutes: 121 }, 'sessionIdleMinutes: validation.idleMinutes'],
    [{ auditRetentionDays: 3651 }, 'auditRetentionDays: validation.auditRetention'],
    [{ fileNumberFormat: '' }, 'fileNumberFormat: validation.required'],
    [{ fileNumberFormat: `${'x'.repeat(65)}` }, 'fileNumberFormat: validation.tooLong'],
    [{ fileNumberFormat: '{YEAR}' }, 'fileNumberFormat: validation.fileNumberFormat'],
  ])('should refuse settings %j', (body, expected) => {
    expect(messages(UpdateOfficeSettingsSchema.safeParse(body))).toContain(expected);
  });

  it('should accept valid settings and clear the default rate', () => {
    expect(
      UpdateOfficeSettingsSchema.parse({
        taxRatePercent: '16.5',
        defaultBillingRate: '',
        fileNumberFormat: ' {YEAR}/{SEQ:4} ',
        sessionIdleMinutes: 15,
        auditRetentionDays: 365,
      }),
    ).toEqual({
      taxRatePercent: '16.5',
      defaultBillingRate: null,
      fileNumberFormat: '{YEAR}/{SEQ:4}',
      sessionIdleMinutes: 15,
      auditRetentionDays: 365,
    });
  });
});
