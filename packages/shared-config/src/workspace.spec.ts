import { WORKSPACE_SCOPE } from './workspace.js';

describe('WORKSPACE_SCOPE', () => {
  it('should be @nexlegtiq (D-001)', () => {
    expect(WORKSPACE_SCOPE).toBe('@nexlegtiq');
  });
});
