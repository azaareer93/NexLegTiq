import { extensionOf, sniffFileType } from './file-type';

const bytes = (...values: number[]) => Buffer.from([...values, 0, 0, 0, 0]);
const zip = (...names: string[]) =>
  Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(names.join('\0'), 'latin1')]);

describe('sniffFileType', () => {
  it.each([
    [Buffer.from('%PDF-1.7 ...'), 'عقد.PDF', 'pdf', 'application/pdf'],
    [bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'scan.png', 'png', 'image/png'],
    [bytes(0xff, 0xd8, 0xff, 0xe0), 'photo.jpeg', 'jpg', 'image/jpeg'],
    [bytes(0x49, 0x49, 0x2a, 0x00), 'fax.tif', 'tiff', 'image/tiff'],
    [bytes(0x4d, 0x4d, 0x00, 0x2a), 'fax.tiff', 'tiff', 'image/tiff'],
    [bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1), 'old.doc', 'doc', 'application/msword'],
    [
      zip('[Content_Types].xml', 'word/document.xml'),
      'brief.docx',
      'docx',
      expect.stringContaining('wordprocessingml'),
    ],
    [
      zip('[Content_Types].xml', 'xl/workbook.xml'),
      'fees.xlsx',
      'xlsx',
      expect.stringContaining('spreadsheetml'),
    ],
    [Buffer.from('name,amount\n\xd3,1\n', 'latin1'), 'list.csv', 'csv', 'text/csv'],
  ])('should accept %#', (head, filename, ext, mimeType) => {
    expect(sniffFileType(head, filename)).toEqual({ ext, mimeType });
  });

  it.each([
    ['an executable named .pdf', Buffer.from('MZ\x90\0'), 'invoice.pdf'],
    ['a PNG named .pdf', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'scan.pdf'],
    ['a PDF without extension', Buffer.from('%PDF-1.7'), 'contract'],
    ['an OLE file named .xls', bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1), 'old.xls'],
    ['a plain ZIP named .docx', zip('photo.jpg'), 'brief.docx'],
    [
      'a ZIP naming both main parts',
      zip('[Content_Types].xml', 'word/document.xml', 'xl/workbook.xml'),
      'x.docx',
    ],
    ['a package without its main part', zip('[Content_Types].xml', 'word/other.xml'), 'x.docx'],
    [
      'a macro-enabled document renamed .docx',
      zip('[Content_Types].xml', 'word/document.xml', 'word/vbaProject.bin'),
      'x.docx',
    ],
    ['a binary named .csv', Buffer.from('MZ\0\0'), 'list.csv'],
    ['text named .txt', Buffer.from('hello'), 'notes.txt'],
    ['an empty file', Buffer.alloc(0), 'empty.csv'],
  ])('should refuse %s', (_, head, filename) => {
    expect(sniffFileType(head, filename)).toBeNull();
  });

  it('should read the extension after the last dot, lower-cased', () => {
    expect(extensionOf('a.b.PDF')).toBe('pdf');
    expect(extensionOf('.hidden')).toBe('');
    expect(extensionOf('noext')).toBe('');
  });
});
