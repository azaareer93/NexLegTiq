import { I18N_NAMESPACES } from './namespaces.js';

describe('I18N_NAMESPACES', () => {
  it('should include the common namespace', () => {
    expect(I18N_NAMESPACES).toContain('common');
  });
});
