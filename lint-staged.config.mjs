/**
 * Pre-commit (scripts/git-hooks/pre-commit, D-094): format and lint only the staged files. ESLint looks up each file's own
 * project config (`v10_config_lookup_from_file`), so app rules (no-literal-string) apply as in `nx lint`.
 */
const eslint = 'eslint --flag v10_config_lookup_from_file --fix --max-warnings=0 --no-warn-ignored';

export default {
  '*.{ts,tsx,js,jsx,mjs,cjs}': ['prettier --write', eslint],
  '*.css': ['prettier --write', 'stylelint --fix'],
  '*.{json,yml,yaml,html}': 'prettier --write',
};
