import { splitText } from './split-text';

describe('splitText (D-148)', () => {
  it('should keep a short text whole and drop empty input', () => {
    expect(splitText('One paragraph.', 100)).toEqual(['One paragraph.']);
    expect(splitText('  \n\n ', 100)).toEqual([]);
  });

  it('should break at paragraph and page breaks, never above the size', () => {
    const text = `${'a'.repeat(40)}\n\n${'b'.repeat(40)}\f${'c'.repeat(40)}`;
    const parts = splitText(text, 90);
    expect(parts.join('')).toBe(text);
    expect(parts.every((part) => part.length <= 90)).toBe(true);
    expect(parts).toHaveLength(2);
  });

  it('should cut a paragraph longer than a part at its last space, or at the size without one', () => {
    const words = 'word '.repeat(50);
    const parts = splitText(words, 42);
    expect(parts.join('')).toBe(words);
    expect(parts.every((part) => part.length <= 42 && part.endsWith(' '))).toBe(true);
    const solid = 'x'.repeat(100);
    expect(splitText(solid, 40)).toEqual(['x'.repeat(40), 'x'.repeat(40), 'x'.repeat(20)]);
  });
});
