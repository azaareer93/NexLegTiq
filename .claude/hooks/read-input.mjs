// Shared helper: read the hook JSON payload from stdin.
export async function readInput() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}
/** Block the tool call: message goes to Claude via stderr, exit code 2. */
export function block(reason) {
  process.stderr.write(`BLOCKED by NexLegTiq hook: ${reason}\n`);
  process.exit(2);
}
