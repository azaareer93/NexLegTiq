import {
  BulkAssignTasksSchema,
  CreateTaskSchema,
  ReorderTasksSchema,
  TaskQuerySchema,
  UpdateTaskSchema,
} from './task.contract.js';

const TASK = '01920000-0000-7000-8000-0000000000a1';
const USER = '01920000-0000-7000-8000-000000000002';

const messages = (result: { error?: { issues: { message: string }[] } }) =>
  (result.error?.issues ?? []).map((issue) => issue.message);

describe('CreateTaskSchema', () => {
  it('should trim the title, default the priority and accept a calendar due date', () => {
    expect(CreateTaskSchema.parse({ title: '  Draft  ', dueDate: '2026-11-02' })).toEqual({
      title: 'Draft',
      dueDate: '2026-11-02',
      priority: 'MEDIUM',
    });
  });

  it('should refuse an empty title, a non-ISO date and an unknown priority', () => {
    expect(
      messages(CreateTaskSchema.safeParse({ title: ' ', dueDate: '02/11/2026', priority: 'X' })),
    ).toEqual(expect.arrayContaining(['validation.required']));
    expect(CreateTaskSchema.safeParse({ title: 'x', dueDate: '02/11/2026' }).success).toBe(false);
  });
});

describe('UpdateTaskSchema', () => {
  it('should allow clearing with null but not an empty body', () => {
    expect(UpdateTaskSchema.parse({ dueDate: null, description: null })).toEqual({
      dueDate: null,
      description: null,
    });
    expect(messages(UpdateTaskSchema.safeParse({}))).toEqual(['validation.required']);
  });
});

describe('ReorderTasksSchema and BulkAssignTasksSchema', () => {
  it('should refuse duplicates, empty lists and more than 100 ids', () => {
    expect(
      messages(ReorderTasksSchema.safeParse({ status: 'TODO', taskIds: [TASK, TASK] })),
    ).toEqual(['validation.duplicate']);
    expect(messages(BulkAssignTasksSchema.safeParse({ taskIds: [], assignedToId: USER }))).toEqual([
      'validation.required',
    ]);
    const many = Array.from(
      { length: 101 },
      (_, i) => `01920000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(BulkAssignTasksSchema.safeParse({ taskIds: many, assignedToId: USER }).success).toBe(
      false,
    );
  });
});

describe('TaskQuerySchema', () => {
  it('should read assignee=me or an id, overdue as a boolean, and page defaults', () => {
    expect(TaskQuerySchema.parse({ assignee: 'me', overdue: 'false' })).toEqual({
      assignee: 'me',
      overdue: false,
      page: 1,
      limit: 20,
    });
    expect(TaskQuerySchema.parse({ assignee: USER, overdue: 'true', limit: '100' })).toMatchObject({
      assignee: USER,
      overdue: true,
      limit: 100,
    });
    expect(TaskQuerySchema.safeParse({ assignee: 'someone' }).success).toBe(false);
    expect(TaskQuerySchema.safeParse({ overdue: 'yes' }).success).toBe(false);
  });
});
