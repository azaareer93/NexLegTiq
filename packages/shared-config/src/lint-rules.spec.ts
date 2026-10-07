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

/** Rule ids reported for `code` linted as `file` inside `project` with that project's eslint.config.mjs. */
async function ruleIds(project: string, file: string, code: string): Promise<string[]> {
  const eslint = linters.get(project) ?? fixtureLinter(project);
  linters.set(project, eslint);
  const [result] = await eslint.lintText(code, { filePath: resolve(project, file) });
  return (result?.messages ?? []).map((message) => message.ruleId ?? message.message);
}

describe('backend lint bans', () => {
  it.each([
    ['$queryRawUnsafe', 'export const q = (db: any) => db.$queryRawUnsafe("SELECT 1");'],
    ['$executeRawUnsafe', 'export const q = (db: any) => db.$executeRawUnsafe("DELETE FROM x");'],
  ])(
    'should reject %s',
    async (_case, code) => {
      expect(await ruleIds(backend, 'src/x.ts', code)).toContain('no-restricted-properties');
    },
    60_000,
  );

  it.each([
    ['a string key', "export const f = (redis: { get(k: string): void }) => redis.get('cases:1');"],
    [
      'a template key',
      'export const f = (cache: { set(k: string, v: number): void }, id: string) => cache.set(`o:${id}:x`, 1);',
    ],
    [
      'a concatenated key',
      "export const f = (this_redis: { del(k: string): void }, id: string) => this_redis.del('x:' + id);",
    ],
  ])('should reject %s for a Redis/cache client', async (_case, code) => {
    expect(await ruleIds(backend, 'src/x.ts', code)).toContain('nexlegtiq/no-raw-cache-key');
  });

  it.each([
    [
      'a key from CacheKeys',
      'declare const CacheKeys: { tenant(o: string, ...p: string[]): string };\nexport const f = (redis: { get(k: string): void }, o: string) => redis.get(CacheKeys.tenant(o, "cases"));',
    ],
    ['a Map with a string key', "export const f = (map: Map<string, number>) => map.get('a');"],
  ])('should accept %s', async (_case, code) => {
    expect(await ruleIds(backend, 'src/x.ts', code)).not.toContain('nexlegtiq/no-raw-cache-key');
  });

  it('should require a reason for prisma.unscoped()', async () => {
    const call = 'export const f = (prisma: { unscoped(): void }) => {\n  prisma.unscoped();\n};';
    expect(await ruleIds(backend, 'src/x.ts', call)).toContain('nexlegtiq/unscoped-needs-reason');
    const justified =
      'export const f = (prisma: { unscoped(): void }) => {\n  // unscoped: signup creates the office\n  prisma.unscoped();\n};';
    expect(await ruleIds(backend, 'src/x.ts', justified)).not.toContain(
      'nexlegtiq/unscoped-needs-reason',
    );
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
    const ids = await ruleIds(backend, 'src/x.ts', code);
    expect(ids).toEqual(
      expect.arrayContaining([
        '@typescript-eslint/no-explicit-any',
        '@typescript-eslint/no-floating-promises',
        'max-depth',
      ]),
    );
  });

  it('should reject a physical property in an inline style, and accept the logical one', async () => {
    const physical = 'export const X = () => <div style={{ marginLeft: 8 }} />;';
    expect(await ruleIds(officeApp, 'src/x.tsx', physical)).toContain('no-restricted-syntax');
    const logical =
      'export const X = () => <div style={{ marginInlineStart: 8, insetInlineEnd: 0 }} />;';
    expect(await ruleIds(officeApp, 'src/x.tsx', logical)).not.toContain('no-restricted-syntax');
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
    'a { padding-right: 4px; }',
    'a { left: 0; }',
    'a { border-left: 1px solid; }',
    'a { text-align: right; }',
  ])('should reject %s', async (css) => {
    expect(await lint(css)).not.toEqual([]);
  });

  it('should accept logical properties', async () => {
    expect(
      await lint('a { margin-inline-start: 4px; inset-inline-end: 0; text-align: start; }'),
    ).toEqual([]);
  });
});
