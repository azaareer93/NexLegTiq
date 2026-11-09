import { CreateTaskTemplateSchema, UpdateTaskTemplateSchema } from './task-template.contract.js';

describe('task template contracts (D-156)', () => {
  it('should default the assignee to the responsible lawyer and bound the days', () => {
    expect(
      CreateTaskTemplateSchema.parse({ name: 'Claim', defaultTitle: 'Prepare' }),
    ).toMatchObject({
      defaultAssigneeRole: 'RESPONSIBLE_LAWYER',
    });
    for (const days of [-1, 366, 1.5]) {
      expect(
        CreateTaskTemplateSchema.safeParse({ name: 'x', defaultTitle: 'y', dueDaysAfterOpen: days })
          .success,
      ).toBe(false);
    }
    expect(CreateTaskTemplateSchema.safeParse({ name: '', defaultTitle: 'y' }).success).toBe(false);
    expect(
      CreateTaskTemplateSchema.safeParse({
        name: 'x',
        defaultTitle: 'y',
        defaultAssigneeRole: 'MEMBER',
      }).success,
    ).toBe(false);
    expect(UpdateTaskTemplateSchema.parse({ fileType: null, isActive: false })).toEqual({
      fileType: null,
      isActive: false,
    });
  });
});
