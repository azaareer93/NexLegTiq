import { createHash } from 'node:crypto';

import { DOMAIN } from './demo-shared';
import type { DemoFile, PutObject, Staff } from './demo-shared';
import { uuidV7 } from '../src/common/ids/uuid-v7';
import type { PrismaClient } from '../src/generated/prisma/client';

/** A one-page PDF with an ASCII caption: enough for the viewer, the download link and the storage quota. */
export function samplePdf(caption: string): Buffer {
  const text = caption.replace(/[^\x20-\x7e]/g, '?').replace(/[()\\]/g, '');
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const offset = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const DOCS = [
  [
    'لائحة دعوى.pdf',
    'PLEADING',
    'AR',
    'بسم الله الرحمن الرحيم. لدى محكمة بداية رام الله الموقرة. لائحة دعوى مطالبة مالية (نموذج تجريبي).',
  ],
  [
    'عقد توريد موقع.pdf',
    'FINAL_CONTRACT',
    'AR',
    'عقد توريد بين شركة الأمثلة للتجارة وشركة النموذج للمقاولات. هذا مستند تجريبي ممسوح ضوئيًا.',
  ],
  [
    'Power of attorney.pdf',
    'POWER_OF_ATTORNEY',
    'EN',
    'Power of attorney granted to the demo office. Sample document.',
  ],
  [
    'قرار المحكمة.pdf',
    'COURT_ORDER',
    'AR',
    'قررت المحكمة تأجيل الجلسة إلى موعد لاحق لتقديم البينات. (نسخة تجريبية ممسوحة)',
  ],
  [
    'Client instructions.pdf',
    'CLIENT_INSTRUCTION',
    'MIXED',
    'Client instructions — تعليمات الموكل حول التسوية. Demo.',
  ],
  ['إنذار عدلي.pdf', 'LEGAL_NOTICE', 'AR', 'إنذار عدلي بالإخلاء موجه إلى المستأجر (مثال تجريبي).'],
] as const;

export async function createDocuments(
  prisma: PrismaClient,
  officeId: string,
  staff: Staff,
  files: readonly DemoFile[],
  put: NonNullable<PutObject>,
) {
  for (const [i, [name, documentType, language, text]] of DOCS.entries()) {
    const file = files[i * 2];
    if (!file) break;
    const id = uuidV7();
    const pdf = samplePdf(`NexLegTiq demo document ${i + 1}`);
    const storageKey = `${officeId}/${file.id}/${id}/${uuidV7()}.pdf`;
    await put(storageKey, pdf);
    const meta = {
      originalFilename: name,
      mimeType: 'application/pdf',
      sizeBytes: BigInt(pdf.length),
      checksumSha256: createHash('sha256').update(pdf).digest('hex'),
      storageKey,
    };
    await prisma.document.create({
      data: {
        id,
        officeId,
        fileId: file.id,
        name,
        documentType,
        ...meta,
        status: 'READY',
        ocrStatus: 'DONE',
        language,
        uploadedById: staff.managerId,
      },
    });
    await prisma.documentVersion.create({
      data: { officeId, documentId: id, versionNumber: 1, ...meta, createdById: staff.managerId },
    });
    await prisma.documentText.create({
      data: { officeId, documentId: id, versionNumber: 1, text, pageCount: 1, ocrEngine: 'demo' },
    });
    await prisma.caseTimelineEvent.create({
      data: {
        officeId,
        fileId: file.id,
        eventType: 'DOCUMENT_UPLOADED',
        actorId: staff.managerId,
        sourceType: 'Document',
        sourceId: id,
        payload: { name },
      },
    });
  }
}

export const DEMO_PORTAL_EMAIL = `client@${DOMAIN}`;

export async function createPortalClient(
  prisma: PrismaClient,
  officeId: string,
  staff: Staff,
  clientId: string,
) {
  const user = await prisma.clientUser.upsert({
    where: { email: DEMO_PORTAL_EMAIL },
    create: {
      email: DEMO_PORTAL_EMAIL,
      fullName: 'أحمد النموذج (تجريبي)',
      passwordHash: '!',
      emailVerifiedAt: new Date(),
    },
    update: {},
  });
  await prisma.clientPortalAccess.create({
    data: { officeId, clientUserId: user.id, clientId, grantedById: staff.managerId },
  });
}
