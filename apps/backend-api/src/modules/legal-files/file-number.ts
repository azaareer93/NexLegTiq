import type { FileType } from '../../generated/prisma/enums';

/** `{TYPE}` codes of the file number (D-031, D-034 adds CRM for criminal files). */
export const FILE_TYPE_CODES = {
  LITIGATION: 'LIT',
  CRIMINAL: 'CRM',
  CONTRACT_DRAFTING: 'CON',
  LEGAL_ADVISORY: 'ADV',
  COMPLIANCE: 'CMP',
  CONFLICT_RESOLUTION: 'CRS',
  BUSINESS_SUPPORT: 'BUS',
  NDA_REVIEW: 'NDA',
  WILL_TRUST: 'WIL',
  COMPANY_FORMATION: 'INC',
  RENTAL_AGREEMENT: 'RNT',
  EMPLOYMENT_CONTRACT: 'EMP',
} as const satisfies Record<FileType, string>;

type Part =
  { literal: string } | { token: 'YEAR' } | { token: 'TYPE' } | { token: 'SEQ'; width: number };

/** A parsed `OfficeSettings.fileNumberFormat`: what the counter is keyed by, and how to render a number. */
export interface FileNumberFormat {
  readonly usesYear: boolean;
  readonly usesType: boolean;
  render(values: { year: number; fileType: FileType; seq: number }): string;
}

const TOKEN = /\{([^{}]*)\}/g;
/** Literal text: letters, digits and the usual separators — a file number is shown in `<Ltr>` and typed in searches. */
const LITERAL = /^[\p{L}\p{N} ._/#-]*$/u;

/**
 * Parses a format such as `{YEAR}-{TYPE}-{SEQ:5}` (D-031): `{YEAR}` the four-digit year, `{TYPE}` the type code,
 * `{SEQ}` or `{SEQ:n}` (n = 1–9) the sequence padded with zeros to n digits. Exactly one `{SEQ}`; any other `{…}` or a
 * stray brace is refused. The settings API (MVP-48) validates with this before saving.
 */
export function parseFileNumberFormat(format: string): FileNumberFormat {
  const parts: Part[] = [];
  let last = 0;
  for (const match of format.matchAll(TOKEN)) {
    parts.push({ literal: format.slice(last, match.index) });
    parts.push(tokenOf(match[1] ?? '', format));
    last = match.index + match[0].length;
  }
  parts.push({ literal: format.slice(last) });
  for (const part of parts) {
    if ('literal' in part && !LITERAL.test(part.literal)) {
      throw new RangeError(`Invalid file number format "${format}": unexpected "${part.literal}"`);
    }
  }
  if (parts.filter((part) => 'token' in part && part.token === 'SEQ').length !== 1) {
    throw new RangeError(`Invalid file number format "${format}": it needs exactly one {SEQ}`);
  }
  const has = (token: string) => parts.some((part) => 'token' in part && part.token === token);
  return {
    usesYear: has('YEAR'),
    usesType: has('TYPE'),
    render: ({ year, fileType, seq }) =>
      parts.map((part) => renderPart(part, year, fileType, seq)).join(''),
  };
}

function tokenOf(name: string, format: string): Part {
  if (name === 'YEAR' || name === 'TYPE') return { token: name };
  const seq = /^SEQ(?::([1-9]))?$/.exec(name);
  if (seq) return { token: 'SEQ', width: Number(seq[1] ?? 1) };
  throw new RangeError(`Invalid file number format "${format}": unknown {${name}}`);
}

function renderPart(part: Part, year: number, fileType: FileType, seq: number): string {
  if ('literal' in part) return part.literal;
  if (part.token === 'YEAR') return String(year);
  if (part.token === 'TYPE') return FILE_TYPE_CODES[fileType];
  return String(seq).padStart(part.width, '0');
}
