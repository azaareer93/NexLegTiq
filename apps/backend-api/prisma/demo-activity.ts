import { CURRENCY, DAY, RATE, TAX, COURT_TYPES, at, day } from './demo-shared';
import type { DemoFile, Staff } from './demo-shared';
import { uuidV7 } from '../src/common/ids/uuid-v7';
import type { PrismaClient } from '../src/generated/prisma/client';
import { invoiceNumber, invoiceTotals, lineAmount } from '../src/modules/invoices/invoice-math';

export async function createSessions(
  prisma: PrismaClient,
  officeId: string,
  staff: Staff,
  files: readonly DemoFile[],
) {
  const court = files.filter((f) => COURT_TYPES.has(f.type) && f.status === 'OPEN');
  // One slot per session, a day apart, 09:00 Hebron (07:00 UTC): no attending lawyer is ever double-booked.
  const rows = court.flatMap((f, i) => {
    const past = new Date(day(-(i + 1) * 4).getTime() + 7 * 3_600_000);
    const next = new Date(day((i + 1) * 3).getTime() + 7 * 3_600_000);
    return [
      {
        officeId,
        fileId: f.id,
        sessionType: 'HEARING' as const,
        startsAt: past,
        endsAt: new Date(past.getTime() + 3_600_000),
        attendingLawyerId: f.lawyerId,
        outcome: 'ADJOURNED' as const,
        minutes: 'حضر الطرفان، وقررت المحكمة تأجيل الجلسة لتقديم البينات. (تجريبي)',
        createdById: staff.managerId,
      },
      {
        officeId,
        fileId: f.id,
        sessionType: at(['HEARING', 'PRE_TRIAL', 'JUDGMENT_PRONOUNCEMENT'] as const, i),
        startsAt: next,
        endsAt: new Date(next.getTime() + 3_600_000),
        attendingLawyerId: f.lawyerId,
        createdById: staff.managerId,
      },
    ];
  });
  await prisma.session.createMany({ data: rows });
}

export async function createTasks(
  prisma: PrismaClient,
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
          officeId,
          fileId: f.id,
          title: at(titles, i + k),
          dueDate: day(((i + k) % 9) - 3),
          priority: at(['MEDIUM', 'HIGH', 'LOW'] as const, i + k),
          status,
          completedAt: status === 'DONE' ? day(-1) : null,
          assignedToId: k === 0 ? f.lawyerId : staff.paralegalId,
          createdById: staff.managerId,
          sortOrder: k,
        };
      }),
    );
  await prisma.task.createMany({ data: rows });
}

const INVOICE_STATES = [
  'DRAFT',
  'SENT',
  'SENT',
  'PAID',
  'PAID',
  'OVERDUE',
  'SENT',
  'PAID',
] as const;

export async function createBilling(
  prisma: PrismaClient,
  officeId: string,
  staff: Staff,
  files: readonly DemoFile[],
) {
  const hourly = files.filter((_, i) => i % 4 !== 3);
  const entries = hourly.flatMap((f, i) =>
    ['1.50', '2.00', '0.75'].map((hours, k) => ({
      id: uuidV7(),
      officeId,
      fileId: f.id,
      userId: f.lawyerId,
      workDate: day(-(10 + i + k)),
      durationHours: hours,
      description: at(['اجتماع مع الموكل', 'إعداد مذكرة', 'Court attendance', 'بحث قانوني'], i + k),
      hourlyRate: RATE,
      currency: CURRENCY,
      fileIndex: i,
    })),
  );
  const invoiceIds = new Map<number, string>();
  const year = new Date().getUTCFullYear();
  let seq = 0;
  for (const [i, status] of INVOICE_STATES.entries()) {
    const f = hourly[i];
    if (!f) break;
    const mine = entries.filter((e) => e.fileIndex === i);
    const lines = mine.map((e, position) => ({
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
    const issued = status === 'DRAFT' ? null : day(status === 'OVERDUE' ? -45 : -(5 + i));
    const number = status === 'DRAFT' ? null : invoiceNumber(year, (seq += 1));
    const id = uuidV7();
    invoiceIds.set(i, id);
    await prisma.invoice.create({
      data: {
        id,
        officeId,
        clientId: f.clientId,
        fileId: f.id,
        invoiceNumber: number,
        status,
        currency: CURRENCY,
        issueDate: issued,
        dueDate: issued ? new Date(issued.getTime() + 30 * DAY) : null,
        ...totals,
        sentAt: issued,
        paidAt: status === 'PAID' ? day(-2) : null,
        paymentMethod: status === 'PAID' ? 'BANK_TRANSFER' : null,
        createdById: staff.managerId,
      },
    });
    await prisma.invoiceLineItem.createMany({
      data: lines.map((l) => ({ ...l, officeId, invoiceId: id })),
    });
  }
  if (seq > 0) {
    await prisma.invoiceNumberSequence.upsert({
      where: { officeId_year: { officeId, year } },
      create: { officeId, year, lastValue: seq },
      update: { lastValue: seq },
    });
  }
  await prisma.timeEntry.createMany({
    data: entries.map(({ fileIndex, ...e }) => ({
      ...e,
      invoiceId: invoiceIds.get(fileIndex) ?? null,
    })),
  });
}
