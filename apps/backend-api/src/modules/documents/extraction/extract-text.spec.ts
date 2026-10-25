import { autoSummaryWanted } from './auto-summary';
import { extractText, MAX_TEXT_CHARS, MIME, UnreadableDocumentError } from './extract-text';
import { buildDocx, buildPdf, buildXlsx } from './fixtures.test-helper';

const LINE =
  'The tenant shall pay the monthly rent of 1,250 ILS before the fifth day of each month.';

describe('extractText (D-132)', () => {
  it('should read the text layer of a PDF, page by page', async () => {
    const result = await extractText(buildPdf([LINE, `Clause 7: termination. ${LINE}`]), MIME.PDF);
    expect(result).toMatchObject({ kind: 'TEXT', engine: 'pdf-text-layer', pageCount: 2 });
    expect(result.kind === 'TEXT' && result.text).toContain('monthly rent');
    expect(result.kind === 'TEXT' && result.text).toContain('Clause 7: termination.');
  });

  it('should send a PDF with too little text per page to OCR (a scan)', async () => {
    await expect(extractText(buildPdf(['p. 1', 'p. 2']), MIME.PDF)).resolves.toEqual({
      kind: 'NEEDS_OCR',
      pageCount: 2,
    });
  });

  it('should read Word documents, Arabic included', async () => {
    const result = await extractText(buildDocx(['عقد إيجار بين الطرفين', LINE]), MIME.DOCX);
    expect(result).toMatchObject({ kind: 'TEXT', engine: 'docx', pageCount: null });
    expect(result.kind === 'TEXT' && result.text).toContain('عقد إيجار بين الطرفين');
    expect(result.kind === 'TEXT' && result.text).toContain('monthly rent');
  });

  it('should read every sheet of a workbook, cells separated by tabs', async () => {
    const workbook = await buildXlsx({
      Payments: [
        ['Month', 'Amount'],
        ['October', 1250],
      ],
      ملاحظات: [['دفعة متأخرة']],
    });
    const result = await extractText(workbook, MIME.XLSX);
    expect(result).toMatchObject({ kind: 'TEXT', engine: 'xlsx' });
    expect(result.kind === 'TEXT' && result.text).toBe(
      '# Payments\nMonth\tAmount\nOctober\t1250\n# ملاحظات\nدفعة متأخرة',
    );
  });

  it('should read CSV as UTF-8, and as Windows-1256 when it is not UTF-8', async () => {
    const utf8 = Buffer.from('﻿name,amount\nأحمد,100\n', 'utf8');
    await expect(extractText(utf8, MIME.CSV)).resolves.toMatchObject({
      text: 'name,amount\nأحمد,100\n',
    });
    // "أحمد" in Windows-1256.
    const legacy = Buffer.from([0xc3, 0xcd, 0xe3, 0xcf, 0x2c, 0x31]);
    await expect(extractText(legacy, MIME.CSV)).resolves.toMatchObject({
      engine: 'csv',
      text: 'أحمد,1',
    });
  });

  it('should hand images, TIFF and legacy .doc to OCR', async () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/tiff', 'application/msword']) {
      await expect(extractText(Buffer.from('x'), mime)).resolves.toEqual({ kind: 'NEEDS_OCR' });
    }
  });

  it('should refuse unreadable files with UnreadableDocumentError', async () => {
    for (const mime of [MIME.PDF, MIME.DOCX, MIME.XLSX]) {
      await expect(extractText(Buffer.from('not really'), mime)).rejects.toBeInstanceOf(
        UnreadableDocumentError,
      );
    }
  });

  it('should drop NUL characters and cap very long texts', async () => {
    const huge = Buffer.from(`a\u0000b${'x'.repeat(MAX_TEXT_CHARS)}`, 'utf8');
    const result = await extractText(huge, MIME.CSV);
    expect(result.kind === 'TEXT' && result.text.startsWith('ab')).toBe(true);
    expect(result.kind === 'TEXT' && result.text.length).toBe(MAX_TEXT_CHARS - 1);
  });
});

describe('autoSummaryWanted', () => {
  const words = (count: number) => Array.from({ length: count }, (_, i) => `w${i}`).join(' ');

  it('should want a summary only when enabled, for court-relevant types over 500 words', () => {
    expect(autoSummaryWanted(true, 'PLEADING', words(501))).toBe(true);
    expect(autoSummaryWanted(true, 'JUDGMENT', words(500))).toBe(false);
    expect(autoSummaryWanted(true, 'INVOICE', words(2000))).toBe(false);
    expect(autoSummaryWanted(false, 'EVIDENCE', words(2000))).toBe(false);
  });
});
