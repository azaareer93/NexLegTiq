/**
 * Pre-commit (scripts/git-hooks/pre-commit, D-094): format and lint only the staged files. ESLint looks up each file's own
 * project config (`v10_config_lookup_from_file`), so app rules (no-literal-string) apply as in `nx lint`.
 */
const eslint = 'eslint --flag v10_config_lookup_from_file --fix --max-warnings=0 --no-warn-ignored';

export default {
  // ESLint first: its fixes (import order, type imports) are then laid out by Prettier, as `format:check` expects.
  '*.{ts,tsx,js,jsx,mjs,cjs}': [eslint, 'prettier --write'],
  '*.css': ['prettier --write', 'stylelint --fix'],
  '*.{json,yml,yaml,html}': 'prettier --write',
};
