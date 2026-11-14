import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

import { printPdf } from './chromium';

jest.mock('node:child_process', () => ({ execFile: jest.fn() }));

describe('printPdf (D-171)', () => {
  it('should print with a private profile, no secrets in the environment, and clean up', async () => {
    (execFile as unknown as jest.Mock).mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, done: (err: null, out: object) => void) => {
        const out =
          args.find((a) => a.startsWith('--print-to-pdf='))?.slice('--print-to-pdf='.length) ?? '';
        void writeFile(out, '%PDF-test').then(() => done(null, { stdout: '', stderr: '' }));
      },
    );
    process.env.SECRET_FOR_TEST = 'x';
    const pdf = await printPdf('chromium', '<p>hi</p>', new AbortController().signal);
    expect(pdf.toString()).toBe('%PDF-test');
    const [, args, options] = (execFile as unknown as jest.Mock).mock.calls[0] as [
      string,
      string[],
      { env: object },
    ];
    expect(args).toEqual(
      expect.arrayContaining(['--headless', '--no-sandbox', '--no-pdf-header-footer']),
    );
    expect(Object.keys(options.env)).not.toContain('SECRET_FOR_TEST');
    delete process.env.SECRET_FOR_TEST;
  });
});
