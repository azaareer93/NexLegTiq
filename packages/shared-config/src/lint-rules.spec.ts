import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ESLint } from 'eslint';
import stylelint from 'stylelint';

import { fixtureLinter } from './fixture-eslint.js';

/** Fixtures proving the workspace lint bans trigger (MVP-29, D-094): each is linted with the real project config. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const backend = resolve(root, 'apps/backend-api');
const officeApp = resolve(root, 'apps/office-app');

const linters = new Map<string, ESLint>();

/**
 * Rule ids reported for `code` linted as `file` inside `project` with that project's eslint.config.mjs. A parse error fails
 * the test: otherwise every "should accept" assertion would pass on code that was never checked.
 */
async function ruleIds(project: string, file: string, code: string): Promise<string[]> {
  const eslint = linters.get(project) ?? fixtureLinter(project);
  linters.set(project, eslint);
  const [result] = await eslint.lintText(code, { filePath: resolve(project, file) });
  const messages = result?.messages ?? [];
  expect(messages.filter((message) => message.fatal).map((message) => message.message)).toEqual([]);
  return messages.map((message) => message.ruleId ?? '');
}

const backendIds = (code: string) => ruleIds(backend, 'src/x.ts', code);
const DB =
  'declare const db: { $queryRawUnsafe(q: string): void; $executeRawUnsafe(q: string): void };\n';
const REDIS =
  'declare const redis: Record<string, (...args: string[]) => void>;\ndeclare const id: string;\n';
const PRISMA = 'declare const prisma: Record<string, () => void>;\ndeclare const k: string;\n';

describe('backend lint bans', () => {
  it.each([
    ['$queryRawUnsafe', 'db.$queryRawUnsafe("SELECT 1");'],
    ['$executeRawUnsafe', 'db.$executeRawUnsafe("DELETE FROM x");'],
    ['a computed $queryRawUnsafe', "db['$queryRawUnsafe']('SELECT 1');"],
    [
      'a destructured $executeRawUnsafe',
      'const { $executeRawUnsafe } = db;\n$executeRawUnsafe("x");',
    ],
  ])(
    'should reject %s',
    async (_case, code) => {
      expect(await backendIds(`${DB}${code}\nexport {};`)).toContain('no-restricted-properties');
    },
    60_000,
  );

  it.each([
    ['a string key', "redis.get('cases:1');"],
    ['a template key', 'redis.set(`o:${id}:x`, "1");'],
    ['a concatenated key', "redis.del('x:' + id);"],
    ['a computed command', "redis['get']('cases:1');"],
    ['the second key of a multi-key command', "redis.del(id, 'cases:2');"],
    ['a command added for completeness', "redis.setnx('lock', '1');"],
    [
      'a cache client',
      "declare const cache: { set(k: string, v: string): void };\ncache.set('k', 'v');",
    ],
  ])('should reject %s for a Redis/cache client', async (_case, code) => {
    expect(await backendIds(`${REDIS}${code}\nexport {};`)).toContain('nexlegtiq/no-raw-cache-key');
  });

  it.each([
    [
      'a key from CacheKeys',
      'declare const CacheKeys: { tenant(o: string, ...p: string[]): string };\nredis.get(CacheKeys.tenant(id, "cases"));',
    ],
    ['a Map with a string key', "const map = new Map<string, number>();\nmap.get('a');"],
  ])('should accept %s', async (_case, code) => {
    expect(await backendIds(`${REDIS}${code}\nexport {};`)).not.toContain(
      'nexlegtiq/no-raw-cache-key',
    );
  });

  it.each([
    ['a call', 'prisma.unscoped();'],
    ['a computed access', "prisma['unscoped']();"],
    ['a template access', 'prisma[`unscoped`]();'],
    ['a destructuring', 'const { unscoped } = prisma;\nunscoped();'],
    ['a run-time property name', 'prisma[k]();'],
  ])('should require a reason for %s of prisma.unscoped()', async (_case, code) => {
    expect(await backendIds(`${PRISMA}${code}\nexport {};`)).toContain(
      'nexlegtiq/unscoped-needs-reason',
    );
  });

  it('should accept prisma.unscoped() with its reason', async () => {
    const justified = `${PRISMA}// unscoped: signup creates the office\nprisma.unscoped();\nexport {};`;
    expect(await backendIds(justified)).not.toContain('nexlegtiq/unscoped-needs-reason');
  });
});

describe('workspace lint rules', () => {
  it('should reject any, floating promises and deep nesting', async () => {
    const code = [
      'export const a = (x: any): number => x as number;',
      'export function b(p: () => Promise<void>): void {',
      '  p();',
      '}',
      'export function c(n: number): number {',
      '  if (n > 0) { if (n > 1) { if (n > 2) { if (n > 3) { return 4; } } } }',
      '  return 0;',
      '}',
    ].join('\n');
    expect(await backendIds(code)).toEqual(
      expect.arrayContaining([
        '@typescript-eslint/no-explicit-any',
        '@typescript-eslint/no-floating-promises',
        'max-depth',
      ]),
    );
  });

  it.each([
    ['marginLeft', '{ marginLeft: 8 }'],
    ['right', '{ right: 0 }'],
    ['a quoted key', "{ 'paddingRight': 4 }"],
    ['a corner radius', '{ borderTopLeftRadius: 4 }'],
    ['textAlign: left', "{ textAlign: 'left' }"],
    ['float: right', "{ float: 'right' }"],
  ])('should reject %s in an inline style', async (_case, style) => {
    const code = `export const X = () => <div style={${style}} />;`;
    expect(await ruleIds(officeApp, 'src/x.tsx', code)).toContain('no-restricted-syntax');
  });

  it('should accept logical properties in an inline style', async () => {
    const code =
      "export const X = () => <div style={{ marginInlineStart: 8, insetInlineEnd: 0, textAlign: 'start' }} />;";
    expect(await ruleIds(officeApp, 'src/x.tsx', code)).not.toContain('no-restricted-syntax');
  });
});

describe('stylelint', () => {
  const lint = async (code: string) => {
    const { results } = await stylelint.lint({
      code,
      configFile: resolve(root, 'stylelint.config.mjs'),
    });
    return (results[0]?.warnings ?? []).map((warning) => warning.rule);
  };

  it.each([
    'a { margin-left: 4px; }',
    'a { margin-right: 4px; }',
    'a { padding-right: 4px; }',
    'a { left: 0; }',
    'a { right: 0; }',
    'a { border-left: 1px solid; }',
    'a { border-left-color: red; }',
    'a { border-top-left-radius: 4px; }',
    'a { text-align: right; }',
    'a { float: left; }',
    'a { clear: right; }',
  ])('should reject %s', async (css) => {
    expect(await lint(css)).not.toEqual([]);
  });

  it('should accept logical properties', async () => {
    expect(
      await lint(
        'a { margin-inline-start: 4px; inset-inline-end: 0; text-align: start; float: inline-start; }',
      ),
    ).toEqual([]);
  });
});
