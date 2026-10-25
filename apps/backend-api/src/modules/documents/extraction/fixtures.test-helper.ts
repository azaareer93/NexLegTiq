import { crc32 } from 'node:zlib';

import ExcelJS from 'exceljs';

/**
 * Test-only fixtures built in code. The one exception: the scanned-page JPEGs in `fixtures/` (Arabic text cannot be
 * rendered from code, D-139).
 */

/** A PDF with one Helvetica text line per page and a correct cross-reference table. */
export function buildPdf(pages: readonly string[]): Buffer {
  const objects: string[] = [];
  const add = (body: string): number => objects.push(body);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(''); // the page tree, filled in once the pages exist
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids: number[] = [];
  for (const text of pages) {
    const escaped = text.replace(/[\\()]/g, (char) => `\\${char}`);
    const stream = `BT /F1 12 Tf 50 750 Td (${escaped}) Tj ET`;
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, index) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** A scanned PDF: `pages` pages that each show the same grayscale JPEG and hold no text layer. */
export function buildImagePdf(jpeg: Buffer, width: number, height: number, pages: number): Buffer {
  const header = Buffer.from('%PDF-1.4\n', 'latin1');
  const parts: Buffer[] = [header];
  const offsets: number[] = [];
  let size = header.length;
  const add = (...chunks: Buffer[]): number => {
    offsets.push(size);
    const id = offsets.length;
    const head = Buffer.from(`${id} 0 obj\n`, 'latin1');
    const tail = Buffer.from('\nendobj\n', 'latin1');
    parts.push(head, ...chunks, tail);
    size += head.length + chunks.reduce((total, chunk) => total + chunk.length, 0) + tail.length;
    return id;
  };
  const text = (value: string) => Buffer.from(value, 'latin1');
  add(text('<< /Type /Catalog /Pages 2 0 R >>'));
  // Objects: 1 catalog, 2 page tree, 3 image, 4 content stream, then one per page.
  const kids = Array.from({ length: pages }, (_, page) => 5 + page);
  add(
    text(`<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages} >>`),
  );
  add(
    text(
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
    ),
    jpeg,
    text('\nendstream'),
  );
  // The image drawn over an A4-ish page (72 points per inch: about 150 dpi).
  const draw = `q ${(width * 72) / 150} 0 0 ${(height * 72) / 150} 0 0 cm /Im1 Do Q`;
  add(text(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`));
  for (let page = 0; page < pages; page += 1) {
    add(
      text(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${(width * 72) / 150} ${(height * 72) / 150}] /Resources << /XObject << /Im1 3 0 R >> >> /Contents 4 0 R >>`,
      ),
    );
  }
  const xref = size;
  let trailer = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
  trailer += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  trailer += `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  parts.push(text(trailer));
  return Buffer.concat(parts);
}

/** A minimal ZIP (stored, no compression) of the given entries. */
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content, 'utf8');
    const fileName = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, data);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const xml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A Word document with one paragraph per entry. */
export function buildDocx(paragraphs: readonly string[]): Buffer {
  const body = paragraphs.map((text) => `<w:p><w:r><w:t>${xml(text)}</w:t></w:r></w:p>`).join('');
  return zip({
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  });
}

/** A workbook with the given sheets of rows. */
export async function buildXlsx(
  sheets: Record<string, readonly (readonly (string | number)[])[]>,
): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const sheet = book.addWorksheet(name);
    for (const row of rows) sheet.addRow([...row]);
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}
