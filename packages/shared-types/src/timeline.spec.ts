import { PORTAL_TIMELINE_EVENT_TYPES, TIMELINE_EVENT_TYPES } from './timeline.js';

/** The portal's public timeline is a privacy boundary (D-003, D-150): changing this set is a decision, not a refactor. */
describe('PORTAL_TIMELINE_EVENT_TYPES', () => {
  it('should hold exactly the file milestones, hearings, shared documents and invoices', () => {
    expect([...PORTAL_TIMELINE_EVENT_TYPES].sort()).toEqual([
      'DOCUMENT_SHARED',
      'FILE_CLOSED',
      'FILE_OPENED',
      'FILE_REOPENED',
      'INVOICE_PAID',
      'INVOICE_SENT',
      'SESSION_CREATED',
      'SESSION_UPDATED',
    ]);
    for (const type of PORTAL_TIMELINE_EVENT_TYPES) expect(TIMELINE_EVENT_TYPES).toContain(type);
  });
});
