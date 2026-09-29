import { buildApiUrl } from './api-url.js';

describe('buildApiUrl', () => {
  it('should prefix the versioned base path', () => {
    expect(buildApiUrl('https://api.example.test', 'offices/me')).toBe(
      'https://api.example.test/api/v1/offices/me',
    );
  });

  it('should not duplicate slashes', () => {
    expect(buildApiUrl('http://localhost:3000/', '/cases')).toBe('http://localhost:3000/api/v1/cases');
  });
});
