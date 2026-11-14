import { DEMO_STAFF, samplePdf } from '../../prisma/demo-content';
import { assertDemoDatabase, demoAllowed } from '../../prisma/seed-demo';

describe('demo seed (D-175)', () => {
  it('should write a well-formed one-page PDF whose xref points at its objects', () => {
    const pdf = samplePdf('Demo (1)').toString('latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    const xref = Number(/startxref\n(\d+)/.exec(pdf)?.[1]);
    expect(pdf.slice(xref, xref + 4)).toBe('xref');
    const offsets = [...pdf.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((offset, i) =>
      expect(pdf.slice(offset).startsWith(`${i + 1} 0 obj`)).toBe(true),
    );
    // Parentheses would end the PDF string early; they are dropped.
    expect(pdf).toContain('(Demo 1)');
  });

  it('should run only in development, test or on a demo deployment that asks for it', () => {
    expect(demoAllowed({ NODE_ENV: 'development' })).toBe(true);
    expect(demoAllowed({ NODE_ENV: 'test' })).toBe(true);
    expect(demoAllowed({ NODE_ENV: 'production' })).toBe(false);
    expect(demoAllowed({})).toBe(false);
    expect(demoAllowed({ NODE_ENV: 'production', SEED_DEMO: 'true' })).toBe(true);
  });

  it('should name every demo person as a demo', () => {
    expect(DEMO_STAFF.every(([, , name]) => /تجريبي|Demo/.test(name))).toBe(true);
    expect(new Set(DEMO_STAFF.map(([role]) => role)).size).toBe(6);
  });

  it('should refuse a demo seed outside development/test on a database with real offices', async () => {
    const db = (others: number) =>
      ({ office: { count: jest.fn().mockResolvedValue(others) } }) as never;
    await expect(
      assertDemoDatabase(db(3), { NODE_ENV: 'production', SEED_DEMO: 'true' }),
    ).rejects.toThrow('refused');
    await expect(
      assertDemoDatabase(db(0), { NODE_ENV: 'production', SEED_DEMO: 'true' }),
    ).resolves.toBeUndefined();
    await expect(assertDemoDatabase(db(3), { NODE_ENV: 'development' })).resolves.toBeUndefined();
    expect(demoAllowed({ NODE_ENV: 'production', SEED_DEMO: '1' })).toBe(false);
  });
});
