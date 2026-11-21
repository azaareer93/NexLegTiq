import type { z } from 'zod';

/** The follow-up message of the one repair call (`AiExecutor`, and the eval harness, D-195). */
export const repairInstruction = (problem: string): string =>
  `Your previous answer was not valid (${problem}). Answer again with one JSON object only, matching the schema.`;

/** Parses and validates an answer; `problem` names paths and issue codes only (never the text). */
export function check<T>(
  text: string,
  schema: z.ZodType<T>,
): { ok: true; value: T } | { ok: false; problem: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'not JSON' };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  const problem = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`)
    .join('; ');
  return { ok: false, problem };
}
