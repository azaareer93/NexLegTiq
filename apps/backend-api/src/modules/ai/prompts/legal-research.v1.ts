import { z } from 'zod';

import { LEGAL_ASSISTANT_V1 } from './legal-assistant.v1';

/** What the model writes (D-256); the citations come from the search itself, never from this JSON. */
export const LegalResearchOutputSchema = z.object({
  answer: z.string().trim().min(1).max(8000),
  /** Where the answer may not hold for the jurisdiction asked about (another country's law, a repealed text). */
  jurisdictionNote: z.string().trim().max(1000).nullable(),
});
export type LegalResearchOutput = z.infer<typeof LegalResearchOutputSchema>;

export interface LegalResearchInput {
  readonly question: string;
  /** The jurisdiction in English words, e.g. "Palestine". */
  readonly jurisdiction: string;
  readonly language: 'AR' | 'EN';
}

/** Legal research over web sources (D-256). Never edit in place: add `legal-research.v2.ts`. */
export const LEGAL_RESEARCH_V1 = {
  version: 'legal-research.v1',
  build({ question, jurisdiction, language }: LegalResearchInput) {
    return {
      version: LEGAL_RESEARCH_V1.version,
      system: [
        LEGAL_ASSISTANT_V1.system(language === 'AR' ? 'ar' : 'en'),
        `Answer a general legal research question about the law of ${jurisdiction}, using the web search results.`,
        'Prefer official sources: legislation databases, official gazettes and court rulings. Name the law, article and',
        'date you rely on, and say when a text may have been amended or repealed. Base every statement on the search',
        'results; when they do not answer the question, say so instead of guessing. Do not list URLs in the answer.',
        'Put in jurisdictionNote any limit of the answer for that jurisdiction (another country, a draft, an old text), or null.',
      ].join('\n'),
      user: question,
    };
  },
} as const;
