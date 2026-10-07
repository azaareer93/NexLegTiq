/**
 * Conventional commits (D-070): `type(scope): subject`, a body, and the required `Refs: MVP-<n>` footer. Footers such as
 * `Co-Authored-By:` are allowed; the PR title (`[MVP-n] …`) is checked by CI, not here.
 */
export default {
  extends: ['@commitlint/config-conventional'],
  parserPreset: { parserOpts: { issuePrefixes: ['MVP-'] } },
  rules: {
    'header-max-length': [2, 'always', 100],
    // Every commit names its ticket: `Refs: MVP-<n>` (D-070).
    'references-empty': [2, 'never'],
    // Subjects may start with a decision id or a proper noun (`docs: D-094 …`, `build: add Prettier …`).
    'subject-case': [0],
    // Bodies explain the why in prose; a long URL or path must not fail a commit.
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
};
