/**
 * Bidi isolation for plain text (email subjects, page titles, `aria-label`s, CSV), where `<bdi>`/`<Ltr>` cannot be used:
 * a file number, phone or email keeps its own order inside Arabic text and does not reorder the text around it.
 */
const LRI = '\u2066';
const FSI = '\u2068';
const PDI = '\u2069';

/**
 * Explicit direction marks and controls (ALM, LRM, RLM, embeddings, overrides, isolates). Removed from the wrapped text: a PDI
 * or an override inside it would break out of the isolate and reorder what follows (Trojan Source style spoofing).
 */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

const clean = (text: string) => text.replace(BIDI_CONTROLS, '');

/** Left-to-right content (file numbers, phones, emails, URLs). */
export const isolateLtr = (text: string): string => `${LRI}${clean(text)}${PDI}`;

/** Content of unknown direction (a name that may be Arabic or Latin): its own text decides. */
export const isolate = (text: string): string => `${FSI}${clean(text)}${PDI}`;
