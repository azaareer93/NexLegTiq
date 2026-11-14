import { CURRENCY, DAY, RATE, TAX, COURT_TYPES, at, day } from './demo-shared';
import type { Db, DemoFile, Staff } from './demo-shared';
import { uuidV7 } from '../src/common/ids/uuid-v7';
import { invoiceNumber, invoiceTotals, lineAmount } from '../src/modules/invoices/invoice-math';

const HOUR = 3_600_000;

/** A past (adjourned, pointing at the next) and a future hearing for every open dispute, with SESSION_CREATED events. */
export async function createSessions(
  db: Db,
  officeId: string,
  staff: Staff,
  files: readonly DemoFile[],
) {
  const court = files.filter((f) => COURT_TYPES.has(f.type) && f.status === 'OPEN');
  // One slot per session, a day apart, 09:00 Hebron (07:00 UTC): no attending lawyer is ever double-booked.
  const rows = court.flatMap((f, i) => {
    const past = new Date(day(-(i + 1) * 4).getTime() + 7 * HOUR);
    const next = new Date(day((i + 1) * 3).getTime() + 7 * HOUR);
    const nextId = uuidV7();
    const common = {
      officeId,
      fileId: f.id,
      attendingLawyerId: f.lawyerId,
      createdById: staff.managerId,
    };
    return [
      {
        ...common,
        id: uuidV7(),
        sessionType: 'HEARING' as const,
        startsAt: past,
        endsAt: new Date(past.getTime() + HOUR),
        outcome: 'ADJOURNED' as const,
        minutes: 'حضر الطرفان، وقررت المحكمة تأجيل الجلسة لتقديم البينات. (تجريبي)',
        nextSessionId: nextId,
      },
      {
        ...common,
        id: nextId,
        sessionType: at(['HEARING', 'PRE_TRIAL', 'JUDGMENT_PRONOUNCEMENT'] as const, i),
        startsAt: next,
        endsAt: new Date(next.getTime() + HOUR),
      },
    ];
  });
  // The future one first: the past one points at it.
  await db.session.createMany({ data: rows.filter((r) => !('nextSessionId' in r)) });
  await db.session.createMany({ data: rows.filter((r) => 'nextSessionId' in r) });
  await db.caseTimelineEvent.createMany({
    data: rows.map((r) => ({
      officeId,
      fileId: r.fileId,
      eventType: 'SESSION_CREATED' as const,
      actorId: staff.managerId,
      sourceType: 'Session',
      sourceId: r.id,
      payload: { sessionType: r.sessionType, startsAt: r.startsAt.toISOString() },
    })),
  });
}

/** Two tasks per live file: the lawyer's, and the paralegal's only on files the paralegal is on (else the lawyer's). */
export async function createTasks(
  db: Db,
  officeId: string,
  staff: Staff,
  files: readonly DemoFile[],
) {
  const titles = [
    'تحضير لائحة الدعوى',
    'جمع البينات من الموكل',
    'مراجعة مسودة العقد',
    'Call the client back',
  ];
  const rows = files
    .filter((f) => f.status !== 'CLOSED')
    .flatMap((f, i) =>
      [0, 1].map((k) => {
        const status = at(['TODO', 'IN_PROGRESS', 'DONE', 'TODO', 'BLOCKED'] as const, i + k);
        return {
          id: uuidV7(),
          officeId,
          fileId: f.id,
          title: at(titles, i + k),
          dueDate: day(((i + k) % 9) - 3),
          priority: at(['MEDIUM', 'HIGH', 'LOW'] as const, i + k),
          status,
          completedAt: status === 'DONE' ? day(-1) : null,
          assignedToId: k === 1 && f.paralegalId ? f.paralegalId : f.lawyerId,
          createdById: staff.managerId,
          sortOrder: k,
        };
      }),
    );
  await db.task.createMany({ data: rows });
  await db.caseTimelineEvent.createMany({
    data: rows
      .filter((t) => t.status === 'DONE')
      .map((t) => ({
        officeId,
        fileId: t.fileId,
        eventType: 'TASK_COMPLETED' as const,
        actorId: t.assignedToId,
        occurredAt: t.completedAt ?? undefined,
        sourceType: 'Task',
        sourceId: t.id,
        payload: { title: t.title },
      })),
  });
}

/**
 * In issue order (numbers grow with the issue date): a draft, an overdue invoice, three paid and three sent ones whose
 * due date is still ahead — so the stored states are the ones the overdue job would leave (D-162).
 */
const INVOICE_STATES = [
  'DRAFT',
  'OVERDUE',
  'PAID',
  'PAID',
  'PAID',
  'SENT',
  'SENT',
  'SENT',
] as const;
const issuedDaysAgo = (i: number) => 50 - (i - 1) * 6; // i ≥ 1: 50, 44, … 14 days ago

export async function createBilling(
  db: Db,
  officeId: string,
  staff: Staff,
  files: readonly DemoFile[],
) {
  const hourly = files.filter((_, i) => i % 4 !== 3);
  const entries = hourly.flatMap((f, i) =>
    ['1.50', '2.00', '0.75'].map((hours, k) => {
      // Invoiced work comes before its invoice; the rest is recent, never before the file opened.
      const ago = i < INVOICE_STATES.length && i > 0 ? issuedDaysAgo(i) + k + 1 : 2 + k + (i % 5);
      return {
        id: uuidV7(),
        officeId,
        fileId: f.id,
        userId: f.lawyerId,
        workDate: day(-Math.min(ago, f.openedDaysAgo)),
        durationHours: hours,
        description: at(
          ['اجتماع مع الموكل', 'إعداد مذكرة', 'Court attendance', 'بحث قانوني'],
          i + k,
        ),
        hourlyRate: RATE,
        currency: CURRENCY,
        fileIndex: i,
      };
    }),
  );
  const invoiceIds = new Map<number, string>();
  const lastByYear = new Map<number, number>();
  for (const [i, status] of INVOICE_STATES.entries()) {
    const f = hourly[i];
    if (!f) break;
    const mine = entries.filter((e) => e.fileIndex === i);
    invoiceIds.set(
      i,
      await writeInvoice({ db, officeId, staff, f, i, status, entries: mine, lastByYear }),
    );
  }
  for (const [year, lastValue] of lastByYear) {
    await db.invoiceNumberSequence.upsert({
      where: { officeId_year: { officeId, year } },
      create: { officeId, year, lastValue },
      update: { lastValue },
    });
  }
  await db.timeEntry.createMany({
    data: entries.map(({ fileIndex, ...e }) => ({
      ...e,
      invoiceId: invoiceIds.get(fileIndex) ?? null,
    })),
  });
}

interface InvoiceInput {
  readonly db: Db;
  readonly officeId: string;
  readonly staff: Staff;
  readonly f: DemoFile;
  readonly i: number;
  readonly status: (typeof INVOICE_STATES)[number];
  readonly entries: readonly { id: string; description: string; durationHours: string }[];
  readonly lastByYear: Map<number, number>;
}

/** One invoice over the file's entries, numbered by its issue year, with its INVOICE_SENT / INVOICE_PAID events. */
/** What sending (and paying) fixed on an issued invoice: its number by the issue year (D-162), dates and payment. */
function issuedFacts(status: InvoiceInput['status'], i: number, lastByYear: Map<number, number>) {
  if (status === 'DRAFT') return null;
  const issued = day(-issuedDaysAgo(i));
  const year = issued.getUTCFullYear();
  const seq = (lastByYear.get(year) ?? 0) + 1;
  lastByYear.set(year, seq);
  const paidAt = status === 'PAID' ? new Date(issued.getTime() + 10 * DAY) : null;
  return { number: invoiceNumber(year, seq), issued, paidAt };
}

async function writeInvoice({
  db,
  officeId,
  staff,
  f,
  i,
  status,
  entries,
  lastByYear,
}: InvoiceInput): Promise<string> {
  const lines = entries.map((e, position) => ({
    description: e.description,
    quantity: e.durationHours,
    unitPrice: RATE,
    amount: lineAmount(e.durationHours, RATE, CURRENCY),
    position,
    fileId: f.id,
    timeEntryId: e.id,
  }));
  const totals = invoiceTotals(
    lines.map((l) => l.amount),
    TAX,
    true,
    CURRENCY,
  );
  const facts = issuedFacts(status, i, lastByYear);
  const id = uuidV7();
  await db.invoice.create({
    data: {
      id,
      officeId,
      clientId: f.clientId,
      fileId: f.id,
      status,
      currency: CURRENCY,
      ...totals,
      createdById: staff.managerId,
      ...(facts && {
        invoiceNumber: facts.number,
        issueDate: facts.issued,
        dueDate: new Date(facts.issued.getTime() + 30 * DAY),
        sentAt: facts.issued,
        paidAt: facts.paidAt,
        paymentMethod: facts.paidAt ? 'BANK_TRANSFER' : null,
      }),
    },
  });
  await db.invoiceLineItem.createMany({
    data: lines.map((l) => ({ ...l, officeId, invoiceId: id })),
  });
  if (facts) {
    const event = {
      officeId,
      fileId: f.id,
      actorId: staff.managerId,
      sourceType: 'Invoice',
      sourceId: id,
    };
    const payload = { invoiceNumber: facts.number };
    const paid = facts.paidAt
      ? [{ ...event, eventType: 'INVOICE_PAID' as const, occurredAt: facts.paidAt, payload }]
      : [];
    await db.caseTimelineEvent.createMany({
      data: [
        { ...event, eventType: 'INVOICE_SENT' as const, occurredAt: facts.issued, payload },
        ...paid,
      ],
    });
  }
  return id;
}
