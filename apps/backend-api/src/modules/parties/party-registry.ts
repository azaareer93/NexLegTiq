import { Injectable } from '@nestjs/common';
import type { FileParty, NewPartyRequest, Party, PartyQuery } from '@nexlegtiq/shared-contracts';
import { ClsService } from 'nestjs-cls';

import type { RequestContext } from '../../common/context/request-context';
import { FieldCipher } from '../../common/crypto/field-cipher';
import { uuidV7 } from '../../common/ids/uuid-v7';
import { PrismaService } from '../../database/prisma.service';
import type { ScopedTransaction } from '../../database/unit-of-work';
import { Prisma } from '../../generated/prisma/client';
import type { ClientInfo } from '../auth/client-info';
import { truncateUserAgent } from '../auth/client-info';

const ENCRYPTED = {
  nationalId: 'parties.national_id',
  taxId: 'parties.tax_id',
  notes: 'parties.notes',
} as const;
type EncryptedField = keyof typeof ENCRYPTED;

export const PARTY_SELECT = {
  id: true,
  isIndividual: true,
  fullName: true,
  companyName: true,
  phone: true,
  email: true,
  nationalId: true,
  taxId: true,
  address: true,
  legalRepresentative: true,
  notes: true,
  nationalIdIndex: true,
  taxIdIndex: true,
} as const;
export const FILE_PARTY_SELECT = {
  id: true,
  partyType: true,
  roleLabel: true,
  joinedAt: true,
  party: { select: PARTY_SELECT },
} as const;
export type PartyRow = Prisma.PartyGetPayload<{ select: typeof PARTY_SELECT }>;
type FilePartyRow = Prisma.FilePartyGetPayload<{ select: typeof FILE_PARTY_SELECT }>;

/** `%`, `_` and `\` are literal in a search term. */
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, '\\$&')}%`;
export const nameOf = (party: { fullName: string | null; companyName: string | null }) =>
  party.fullName ?? party.companyName ?? '';

/** What the conflict check needs to know about a party. */
export const conflictParty = (party: PartyRow) => ({
  id: party.id,
  name: nameOf(party),
  nationalIdIndex: party.nationalIdIndex,
  taxIdIndex: party.taxIdIndex,
});

/**
 * The office's party registry (D-030, D-135): search, creation with encrypted identifiers and notes (D-056) plus their
 * blind indexes, and the decrypted view of a file party. Also the audit rows of the parties services.
 */
@Injectable()
export class PartyRegistry {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<RequestContext>,
    private readonly cipher: FieldCipher,
  ) {}

  /** Reuse picker: Arabic-normalised name substring, or an exact national/tax id; by name. */
  async search(query: PartyQuery): Promise<Party[]> {
    const officeId = this.officeId();
    const term = query.search.trim();
    const conditions = [Prisma.sql`p.office_id = ${officeId}::uuid`];
    if (term) {
      const matches = [
        Prisma.sql`nlq_normalize_ar(coalesce(p.full_name, p.company_name)) LIKE nlq_normalize_ar(${likePattern(term)})`,
      ];
      const nationalIdIndex = this.cipher.blindIndex(term, `national_id:${officeId}`);
      const taxIdIndex = this.cipher.blindIndex(term, `tax_id:${officeId}`);
      if (nationalIdIndex) matches.push(Prisma.sql`p.national_id_index = ${nationalIdIndex}`);
      if (taxIdIndex) matches.push(Prisma.sql`p.tax_id_index = ${taxIdIndex}`);
      conditions.push(Prisma.sql`(${Prisma.join(matches, ' OR ')})`);
    }
    const page = await this.prisma.db.$queryRaw<{ id: string }[]>`
      SELECT p.id FROM parties p WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY coalesce(p.full_name, p.company_name) ASC, p.id ASC
      LIMIT ${query.limit}`;
    const rows = await this.prisma.db.party.findMany({
      where: { id: { in: page.map((row) => row.id) } },
      select: PARTY_SELECT,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return page.flatMap(({ id }) => {
      const row = byId.get(id);
      return row ? [toParty(row)] : [];
    });
  }

  async create(
    tx: ScopedTransaction,
    input: NewPartyRequest,
    client: ClientInfo,
  ): Promise<PartyRow> {
    const officeId = this.officeId();
    // The id is made here because the ciphertexts are bound to it (D-108).
    const id = uuidV7();
    const party = await tx.party.create({
      data: {
        id,
        officeId,
        isIndividual: input.isIndividual,
        fullName: input.fullName ?? null,
        companyName: input.companyName ?? null,
        nationalId: this.seal('nationalId', id, input.nationalId),
        taxId: this.seal('taxId', id, input.taxId),
        notes: this.seal('notes', id, input.notes),
        nationalIdIndex: this.cipher.blindIndex(input.nationalId, `national_id:${officeId}`),
        taxIdIndex: this.cipher.blindIndex(input.taxId, `tax_id:${officeId}`),
        address: input.address ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        legalRepresentative: input.legalRepresentative ?? null,
      },
      select: PARTY_SELECT,
    });
    const { nationalId, taxId, notes, ...plain } = input;
    await tx.auditLog.create({
      data: this.audit(client, 'Party', id, 'CREATE', null, {
        ...plain,
        ...(nationalId && { nationalId: '[encrypted]' }),
        ...(taxId && { taxId: '[encrypted]' }),
        ...(notes && { notes: '[encrypted]' }),
      }),
    });
    return party;
  }

  present(row: FilePartyRow): FileParty {
    const { party } = row;
    return {
      id: row.id,
      partyType: row.partyType,
      roleLabel: row.roleLabel,
      joinedAt: row.joinedAt.toISOString(),
      party: {
        ...toParty(party),
        nationalId: this.open('nationalId', party.id, party.nationalId),
        taxId: this.open('taxId', party.id, party.taxId),
        address: party.address,
        legalRepresentative: party.legalRepresentative,
        notes: this.open('notes', party.id, party.notes),
      },
    };
  }

  audit(
    client: ClientInfo,
    entityType: 'Party' | 'FileParty' | 'ConflictOfInterest',
    entityId: string,
    action: 'CREATE' | 'UPDATE' | 'DELETE',
    oldValues: object | null,
    newValues: object | null,
  ) {
    return {
      officeId: this.officeId(),
      userId: this.actorId(),
      entityType,
      entityId,
      action,
      ...(oldValues && { oldValues }),
      ...(newValues && { newValues }),
      ipAddress: client.ip,
      userAgent: truncateUserAgent(client.userAgent),
      requestId: client.requestId,
    };
  }

  actorId(): string {
    const userId = this.cls.get('userId');
    if (!userId) throw new Error('No caller in the request context');
    return userId;
  }

  officeId(): string {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the request context');
    return officeId;
  }

  /** Additional data of a party's encrypted field: column, office and row (D-108). */
  private context(field: EncryptedField, partyId: string): string {
    return `${ENCRYPTED[field]}:${this.officeId()}:${partyId}`;
  }

  private seal(field: EncryptedField, partyId: string, value: string | undefined): string | null {
    return value ? this.cipher.encrypt(value, this.context(field, partyId)) : null;
  }

  /** An organisation's tax id written before this story may be plaintext (only individuals' had to be encrypted). */
  private open(field: EncryptedField, partyId: string, value: string | null): string | null {
    if (!value) return null;
    return /^v[0-9]+:/.test(value)
      ? this.cipher.decrypt(value, this.context(field, partyId))
      : value;
  }
}

function toParty(
  row: Pick<PartyRow, 'id' | 'isIndividual' | 'fullName' | 'companyName' | 'phone' | 'email'>,
): Party {
  return {
    id: row.id,
    isIndividual: row.isIndividual,
    name: nameOf(row),
    fullName: row.fullName,
    companyName: row.companyName,
    phone: row.phone,
    email: row.email,
  };
}
