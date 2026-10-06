import { ESLint } from 'eslint';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '../../../apps/office-app');

let eslint: ESLint;

/** Rule ids reported for `code` linted as an office-app file with the app's own config. */
async function ruleErrors(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: resolve(app, file) });
  return (result?.messages ?? []).map((message) => message.ruleId ?? message.message);
}

const component = (jsx: string) =>
  `export function X(): React.JSX.Element {\n  return ${jsx};\n}\n`;

describe('frontend text lint rules (D-087)', () => {
  beforeAll(async () => {
    eslint = new ESLint({ cwd: app });
    await eslint.calculateConfigForFile(resolve(app, 'src/main.tsx'));
  }, 60_000);

  it.each([
    ['JSX text', '<p>Hello</p>'],
    ['a placeholder', '<input placeholder="Search" />'],
    ['an alt text', '<img alt="Logo" src="/logo.png" />'],
    ['an AntD label', '<Item label="Name" />'],
  ])('should reject %s', async (_case, jsx) => {
    expect(await ruleErrors('src/x.tsx', component(jsx))).toContain('i18next/no-literal-string');
  });

  it.each([
    ['translated text', "<p title={t('common.appName')}>{t('common.actions.save')}</p>"],
    [
      'technical attributes',
      '<Button type="primary" htmlType="submit" data-testid="save" className="x" />',
    ],
  ])('should accept %s', async (_case, jsx) => {
    const code = `const t = (key: string) => key;\nconst Button = (_: object) => null;\n${component(jsx)}`;
    expect(await ruleErrors('src/x.tsx', code)).not.toContain('i18next/no-literal-string');
  });

  it.each(['src/x.test.tsx', 'src/x.stories.tsx'])(
    'should not apply to tests and stories (%s)',
    async (file) => {
      expect(await ruleErrors(file, component('<p>Hello</p>'))).not.toContain(
        'i18next/no-literal-string',
      );
    },
  );

  it('should reject raw HTML', async () => {
    expect(
      await ruleErrors(
        'src/x.tsx',
        component('<div dangerouslySetInnerHTML={{ __html: html }} />'),
      ),
    ).toContain('react/no-danger');
  });
});
