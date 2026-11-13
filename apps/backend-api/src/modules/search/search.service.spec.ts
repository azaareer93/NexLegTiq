import { snippetParts } from './search.service';

describe('snippetParts (D-167)', () => {
  it('should split ts_headline markers into plain-text parts', () => {
    expect(snippetParts('the orchard rent and orchard')).toEqual([
      { text: 'the ', match: false },
      { text: 'orchard', match: true },
      { text: ' rent and ', match: false },
      { text: 'orchard', match: true },
    ]);
  });

  it('should return no parts for an empty headline and keep text without markers', () => {
    expect(snippetParts('')).toEqual([]);
    expect(snippetParts('<b>x</b>')).toEqual([{ text: '<b>x</b>', match: false }]);
  });
});
