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

/** Names the office knows, newest first: enough for a question that mentions a client by name. */
const MAX_NAMES = 2000;

/**
 * Who a research question must not name to the provider (D-256): the office's clients, their contacts, parties and
 * users. Passed as `organisations` so they match only whole — a general question shares many words with names
 * (أمين، عادل), and those must stay. Phones, emails, ids and IBANs are found by pattern without a list.
 */
export async function officeRedactionContext(prisma: PrismaService): Promise<RedactionContext> {
  const take = MAX_NAMES;
  const orderBy = { createdAt: 'desc' } as const;
  const [clients, contacts, parties, users] = await Promise.all([
    prisma.db.client.findMany({
      take,
      orderBy,
      select: { displayName: true, fullName: true, companyName: true },
    }),
    prisma.db.contactPerson.findMany({ take, orderBy, select: { fullName: true } }),
    prisma.db.party.findMany({
      take,
      orderBy,
      select: { fullName: true, companyName: true, legalRepresentative: true },
    }),
    prisma.db.user.findMany({ take, orderBy, select: { fullName: true } }),
  ]);
  const names = [
    ...clients.flatMap((c) => [c.displayName, c.fullName, c.companyName]),
    ...contacts.map((c) => c.fullName),
    ...parties.flatMap((p) => [p.fullName, p.companyName, p.legalRepresentative]),
    ...users.map((u) => u.fullName),
  ].filter((name): name is string => Boolean(name?.trim()));
  return { names: [], organisations: [...new Set(names)] };
}
