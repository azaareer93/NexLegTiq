#!/usr/bin/env node
// PreToolUse(Write|Edit|MultiEdit): protect secrets, applied migrations, and generated/lock files.
import { existsSync } from 'node:fs';
import { readInput, block } from './read-input.mjs';

const input = await readInput();
const ti = input?.tool_input ?? {};
const file = String(ti.file_path ?? '');
const text = [ti.content, ti.new_string, ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e?.new_string) : [])]
  .filter(Boolean)
  .join('\n');

if (/(^|\/)\.env(\.[\w-]+)?$/.test(file) && !/\.env\.example$/.test(file)) {
  block(`writing real env files is not allowed (${file}); update .env.example and env.schema.ts instead`);
}
if (/(^|\/)pnpm-lock\.yaml$/.test(file)) block('do not edit pnpm-lock.yaml by hand; run pnpm install');
if (/prisma\/migrations\/[^/]+\/migration\.sql$/.test(file) && existsSync(file) && input?.tool_name !== 'Write') {
  block('never edit an existing migration; create a new one (prisma-change skill)');
}

const secretPatterns = [
  [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key'],
  [/\bsk-(proj-)?[A-Za-z0-9_-]{20,}/, 'OpenAI-style API key'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic API key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'GitHub token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\bre_[A-Za-z0-9]{20,}\b/, 'Resend API key'],
  [/postgres(ql)?:\/\/[^:\s]+:(?!password|postgres|dev_password|test|\$\{)[^@\s]{6,}@(?!localhost|127\.0\.0\.1|postgres\b|db\b)/, 'database URL with real credentials'],
];
for (const [re, what] of secretPatterns) {
  if (re.test(text)) block(`content looks like it contains a ${what}; use env vars / .env.example placeholders`);
}
process.exit(0);
