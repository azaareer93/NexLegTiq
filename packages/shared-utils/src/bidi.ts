/**
 * Bidi isolation for plain text (email subjects, page titles, `aria-label`s, CSV), where `<bdi>`/`<Ltr>` cannot be used:
 * a file number, phone or email keeps its own order inside Arabic text and does not reorder the text around it.
 */
const LRI = '⁦';
const FSI = '⁨';
const PDI = '⁩';

/** Left-to-right content (file numbers, phones, emails, URLs, amounts). */
export const isolateLtr = (text: string): string => `${LRI}${text}${PDI}`;

/** Content of unknown direction (a name that may be Arabic or Latin): its own text decides. */
export const isolate = (text: string): string => `${FSI}${text}${PDI}`;
