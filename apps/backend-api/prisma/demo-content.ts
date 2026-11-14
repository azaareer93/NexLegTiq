import { createBilling, createSessions, createTasks } from './demo-activity';
import { createDocuments, createPortalClient } from './demo-documents';
import { COURT_TYPES, CURRENCY, DOMAIN, RATE, at, day } from './demo-shared';
import type { DemoFile, PutObject, Staff } from './demo-shared';
import { uuidV7 } from '../src/common/ids/uuid-v7';
import type { Prisma, PrismaClient } from '../src/generated/prisma/client';
import { FILE_TYPE_CODES, parseFileNumberFormat } from '../src/modules/legal-files/file-number';

export type { PutObject } from './demo-shared';
export { DEMO_PORTAL_EMAIL, samplePdf } from './demo-documents';

export const DEMO_STAFF = [
  ['SENIOR_LAWYER', 'senior', 'رنا الخطيب (تجريبي)'],
  ['LAWYER', 'lawyer1', 'سامر حداد (تجريبي)'],
  ['LAWYER', 'lawyer2', 'Laila Mansour (Demo)'],
  ['PARALEGAL', 'paralegal', 'نور الصالح (تجريبي)'],
  ['ADMIN', 'admin', 'هبة العمري (تجريبي)'],
  ['TRAINEE', 'trainee', 'يزن قاسم (تجريبي)'],
  ['EXTERNAL_COLLABORATOR', 'external', 'Omar Khalil (Demo)'],
] as const;

const PEOPLE_AR = ['أحمد', 'محمود', 'سارة', 'ريم', 'خالد', 'منى', 'باسل', 'دينا', 'طارق', 'لينا'];
const SURNAMES_AR = ['الأمثلة', 'النموذج', 'التجربة', 'الافتراضي', 'المثال'];
const PEOPLE_EN = [
  'Adam Sample',
  'Maya Example',
  'Karim Placeholder',
  'Rania Testwell',
  'Samir Fictional',
];
const COMPANIES = [
  'شركة الأمثلة للتجارة (تجريبية)',
  'مؤسسة النموذج للمقاولات (تجريبية)',
  'Example Logistics Ltd (Demo)',
  'شركة التجربة للبرمجيات (تجريبية)',
  'Sample Pharma Co (Demo)',
  'جمعية المثال الخيرية (تجريبية)',
  'شركة الافتراض للعقارات (تجريبية)',
  'Placeholder Foods LLC (Demo)',
  'مكتب النموذج للاستشارات الهندسية (تجريبي)',
  'Fictional Textiles Co (Demo)',
];
const TITLES: Readonly<Record<string, readonly string[]>> = {
  LITIGATION: ['دعوى مطالبة مالية', 'دعوى إخلاء مأجور', 'Breach of supply contract claim'],
  CRIMINAL: ['قضية شيك بدون رصيد', 'دفاع في قضية احتيال'],
  CONTRACT_DRAFTING: ['صياغة عقد توريد', 'Drafting a distribution agreement'],
  LEGAL_ADVISORY: ['استشارة في نظام العمل', 'Advice on a commercial lease'],
  COMPLIANCE: ['مراجعة امتثال لحماية البيانات'],
  CONFLICT_RESOLUTION: ['وساطة في نزاع شراكة'],
  BUSINESS_SUPPORT: ['دعم قانوني شهري للشركة'],
  NDA_REVIEW: ['مراجعة اتفاقية عدم إفصاح', 'NDA review for a supplier'],
  WILL_TRUST: ['تنظيم وصية'],
  COMPANY_FORMATION: ['تسجيل شركة مساهمة خصوصية', 'Company registration'],
  RENTAL_AGREEMENT: ['صياغة عقد إيجار تجاري'],
  EMPLOYMENT_CONTRACT: ['مراجعة عقود العاملين'],
};
const FILE_TYPES = Object.keys(TITLES) as (keyof typeof TITLES)[];

/**
 * The demo office's content (MVP-118, D-175): 30 clients, 60 files across every type with their team, hearings past and
 * future, tasks, time entries, invoices in every state, sample documents and one portal client. Written once: an office
 * that already has clients is left as it is (reset first to rebuild it).
 */
export async function seedDemoContent(
  prisma: PrismaClient,
  officeId: string,
  staff: Staff,
  put: PutObject,
): Promise<boolean> {
  if ((await prisma.client.count({ where: { officeId } })) > 0) return false;
  const clients = await createClients(prisma, officeId, staff);
  const files = await createFiles(prisma, officeId, staff, clients);
  await createSessions(prisma, officeId, staff, files);
  await createTasks(prisma, officeId, staff, files);
  await createBilling(prisma, officeId, staff, files);
  if (put) await createDocuments(prisma, officeId, staff, files, put);
  await createPortalClient(prisma, officeId, staff, clients[0]?.id ?? '');
  return true;
}

async function createClients(prisma: PrismaClient, officeId: string, staff: Staff) {
  const rows: Prisma.ClientCreateManyInput[] = [];
  const contacts: Prisma.ContactPersonCreateManyInput[] = [];
  for (let i = 0; i < 20; i++) {
    const name =
      i < 15 ? `${at(PEOPLE_AR, i)} ${at(SURNAMES_AR, i * 3 + 1)}` : at(PEOPLE_EN, i - 15);
    rows.push({
      id: uuidV7(),
      officeId,
      clientType: 'INDIVIDUAL',
      displayName: name,
      fullName: name,
      phone: `+970 59 000 ${String(1000 + i)}`,
      email: `client${i + 1}@${DOMAIN}`,
      address: at(['رام الله', 'نابلس', 'الخليل', 'بيت لحم', 'جنين'], i),
      primaryLawyerId: at(staff.lawyers, i),
    });
  }
  COMPANIES.forEach((name, i) => {
    const id = uuidV7();
    rows.push({
      id,
      officeId,
      clientType: i === 5 ? 'NGO' : 'CORPORATION',
      displayName: name,
      companyName: name,
      email: `company${i + 1}@${DOMAIN}`,
      industry: at(['تجارة', 'مقاولات', 'خدمات لوجستية', 'برمجيات', 'أدوية'], i),
      primaryLawyerId: at(staff.lawyers, i + 1),
    });
    contacts.push({
      officeId,
      clientId: id,
      fullName: `${at(PEOPLE_AR, i + 3)} ${at(SURNAMES_AR, i)} (تجريبي)`,
      position: 'المدير العام',
      email: `contact${i + 1}@${DOMAIN}`,
      isPrimary: true,
    });
  });
  await prisma.client.createMany({ data: rows });
  await prisma.contactPerson.createMany({ data: contacts });
  return rows.map((r) => ({ id: r.id as string }));
}

const statusOf = (i: number) =>
  (i % 10 === 9 ? 'CLOSED' : i % 15 === 7 ? 'SUSPENDED' : 'OPEN') as
    'OPEN' | 'CLOSED' | 'SUSPENDED';
const billingOf = (i: number) =>
  i % 4 === 3
    ? { billingMethod: 'FIXED_FEE' as const, hourlyRate: null, fixedFee: '3000.00' }
    : { billingMethod: 'HOURLY' as const, hourlyRate: RATE, fixedFee: null };

/** The i-th demo file's columns: every 10th closed, a few suspended, every 4th on a fixed fee, court refs for disputes. */
function fileRow(
  i: number,
  type: string,
  opened: Date,
  staff: Staff,
  courts: readonly { id: string }[],
) {
  const status = statusOf(i);
  const court = COURT_TYPES.has(type);
  return {
    id: uuidV7(),
    title: at(TITLES[type] ?? ['ملف تجريبي'], i),
    description: 'ملف تجريبي لأغراض العرض — Demo file for presentations.',
    fileType: type as never,
    status,
    priority: at(['MEDIUM', 'HIGH', 'LOW', 'URGENT'] as const, i),
    openingDate: opened,
    closingDate: status === 'CLOSED' ? new Date(opened.getTime() + 60 * 86_400_000) : null,
    responsibleLawyerId: at(staff.lawyers, i),
    responsibleParalegalId: i % 3 === 0 ? staff.paralegalId : null,
    jurisdiction: 'PALESTINE' as const,
    ...billingOf(i),
    currency: CURRENCY,
    courtId: court && courts.length ? at(courts, i).id : null,
    courtCaseNumber: court ? `${opened.getUTCFullYear()}/${100 + i}` : null,
    isConfidential: i === 11,
  };
}

async function createFiles(
  prisma: PrismaClient,
  officeId: string,
  staff: Staff,
  clients: readonly { id: string }[],
): Promise<DemoFile[]> {
  const settings = await prisma.officeSettings.findUniqueOrThrow({ where: { officeId } });
  const format = parseFileNumberFormat(settings.fileNumberFormat);
  const courts = await prisma.court.findMany({
    where: { officeId: null, jurisdiction: 'PALESTINE' },
    select: { id: true },
    take: 10,
  });
  const counters = new Map<string, { year: number; typeCode: string; lastValue: number }>();
  const files: DemoFile[] = [];
  const rows: Prisma.LegalFileCreateManyInput[] = [];
  for (let i = 0; i < 60; i++) {
    const type = at(FILE_TYPES, i);
    const opened = day(-(400 - i * 6));
    const year = opened.getUTCFullYear();
    const key = {
      year: format.usesYear ? year : 0,
      typeCode: format.usesType ? FILE_TYPE_CODES[type as keyof typeof FILE_TYPE_CODES] : '',
    };
    const counter = counters.get(`${key.year}|${key.typeCode}`) ?? { ...key, lastValue: 0 };
    counter.lastValue += 1;
    counters.set(`${key.year}|${key.typeCode}`, counter);
    const row = fileRow(i, type, opened, staff, courts);
    rows.push({
      ...row,
      officeId,
      fileNumber: format.render({ year, fileType: type as never, seq: counter.lastValue }),
    });
    files.push({
      id: row.id,
      type,
      status: row.status,
      lawyerId: row.responsibleLawyerId,
      clientId: at(clients, i).id,
      openedDaysAgo: 400 - i * 6,
    });
  }
  await prisma.legalFile.createMany({ data: rows });
  for (const c of counters.values()) {
    await prisma.fileNumberSequence.upsert({
      where: { officeId_year_typeCode: { officeId, year: c.year, typeCode: c.typeCode } },
      create: { officeId, ...c },
      update: { lastValue: c.lastValue },
    });
  }
  await prisma.fileClient.createMany({
    data: files.map((f) => ({ officeId, fileId: f.id, clientId: f.clientId, isPrimary: true })),
  });
  await prisma.fileTeamMember.createMany({
    data: rows.flatMap((r) => [
      {
        officeId,
        fileId: r.id as string,
        userId: r.responsibleLawyerId,
        role: 'RESPONSIBLE_LAWYER' as const,
      },
      ...(r.responsibleParalegalId
        ? [
            {
              officeId,
              fileId: r.id as string,
              userId: r.responsibleParalegalId,
              role: 'PARALEGAL' as const,
            },
          ]
        : []),
    ]),
  });
  await prisma.caseTimelineEvent.createMany({
    data: rows.map((r) => ({
      officeId,
      fileId: r.id as string,
      eventType: 'FILE_OPENED' as const,
      actorId: staff.managerId,
      occurredAt: r.openingDate as Date,
      payload: { fileNumber: r.fileNumber },
    })),
  });
  return files;
}
