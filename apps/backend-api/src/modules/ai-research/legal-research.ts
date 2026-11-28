import { createHash } from 'node:crypto';

import { JURISDICTIONS } from '@nexlegtiq/shared-types';
import { z } from 'zod';

import type { PrismaService } from '../../database/prisma.service';
import type { RedactionContext } from '../ai/redaction';

/** The `ai` job that answers a research question (D-256). */
export const LEGAL_RESEARCH_JOB = 'legal-research';
export const LEGAL_RESEARCH_FEATURE = 'legal-research';
/** How long the answer of a job stays readable by its creator. */
export const RESEARCH_JOB_TTL_SECONDS = 86_400;

export const LegalResearchFieldsSchema = z.object({
  question: z.string().min(1).max(2000),
  language: z.enum(['AR', 'EN']),
  jurisdiction: z.enum(JURISDICTIONS),
  /** The question's cache key (`researchHash`). */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type LegalResearchFields = z.infer<typeof LegalResearchFieldsSchema>;

/** Cache parts under `o:{officeId}:ai:` (D-058). */
export const researchKeys = {
  question: (hash: string) => ['research', 'q', hash],
  job: (jobId: string) => ['research', 'job', jobId],
};

/** The same question (spacing and case aside), language and jurisdiction under the same prompt → the same key. */
export function researchHash(
  fields: Omit<LegalResearchFields, 'hash'>,
  promptVersion: string,
): string {
  const question = fields.question.trim().replace(/\s+/g, ' ').toLowerCase();
  return createHash('sha256')
    .update(JSON.stringify([promptVersion, fields.language, fields.jurisdiction, question]))
    .digest('hex');
}

/** Words of a question looked up among the office's names, and rows read per table. */
const MAX_WORDS = 30;
const MAX_ROWS = 500;

/** The words of a question that could be part of a name (3+ letters), lower-cased, at most `MAX_WORDS`. */
export function questionWords(question: string): string[] {
  const words = question
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{M}]+/u)
    .filter((word) => word.length >= 3);
  return [...new Set(words)].slice(0, MAX_WORDS);
}

const present = (values: readonly (string | null)[]): string[] => [
  ...new Set(values.filter((value): value is string => Boolean(value?.trim()))),
];

/**
 * Who a research question must not name to the provider (D-256): every client, contact person, party and user of the
 * office with a name sharing a word with the question — looked up across all rows, so an old client is hidden too.
 * People are matched whole and by their identifying words (a first and family name alone); companies only whole.
 * Phones, emails, ids and IBANs are found by pattern without a list. A name the office does not know (a third party
 * the user types) is not hidden: the page asks not to type case details.
 * shortcut: `contains` scans the four tables per question; add trigram indexes if offices grow past ~100k names.
 */
export async function officeRedactionContext(
  prisma: PrismaService,
  question: string,
): Promise<RedactionContext> {
  const words = questionWords(question);
  if (words.length === 0) return { names: [], organisations: [] };
  const like = <F extends string>(field: F) =>
    words.map(
      (word) =>
        ({ [field]: { contains: word, mode: 'insensitive' } }) as Record<
          F,
          { contains: string; mode: 'insensitive' }
        >,
    );
  const take = MAX_ROWS;
  const [clients, contacts, parties, users] = await Promise.all([
    prisma.db.client.findMany({
      take,
      where: { OR: [...like('displayName'), ...like('fullName'), ...like('companyName')] },
      select: { clientType: true, displayName: true, fullName: true, companyName: true },
    }),
    prisma.db.contactPerson.findMany({
      take,
      where: { OR: like('fullName') },
      select: { fullName: true },
    }),
    prisma.db.party.findMany({
      take,
      where: {
        OR: [...like('fullName'), ...like('companyName'), ...like('legalRepresentative')],
      },
      select: { isIndividual: true, fullName: true, companyName: true, legalRepresentative: true },
    }),
    prisma.db.user.findMany({ take, where: { OR: like('fullName') }, select: { fullName: true } }),
  ]);
  const people = clients.filter((client) => client.clientType === 'INDIVIDUAL');
  const bodies = clients.filter((client) => client.clientType !== 'INDIVIDUAL');
  return {
    names: present([
      ...people.flatMap((client) => [client.displayName, client.fullName]),
      ...contacts.map((contact) => contact.fullName),
      ...parties.filter((party) => party.isIndividual).map((party) => party.fullName),
      ...parties.map((party) => party.legalRepresentative),
      ...users.map((user) => user.fullName),
    ]),
    organisations: present([
      ...bodies.flatMap((client) => [client.displayName, client.companyName]),
      ...parties.filter((party) => !party.isIndividual).map((party) => party.companyName),
    ]),
  };
}
