import { isolate, isolateLtr } from './bidi.js';

const LRI = '\u2066';
const FSI = '\u2068';
const PDI = '\u2069';
const RLO = '\u202E';

describe('bidi isolation', () => {
  it('should isolate left-to-right and unknown-direction text', () => {
    expect(isolateLtr('2026-LIT-00042')).toBe(`${LRI}2026-LIT-00042${PDI}`);
    expect(isolate('ليلى')).toBe(`${FSI}ليلى${PDI}`);
  });

  it('should not let embedded controls break out of the isolate and reorder the text around it', () => {
    const spoof = `ACME${PDI}${RLO}fdp.exe`;
    expect(isolate(spoof)).toBe(`${FSI}ACMEfdp.exe${PDI}`);
    expect(isolateLtr(`\u200F050\u200E-123`)).toBe(`${LRI}050-123${PDI}`);
  });
});
