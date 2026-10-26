/**
 * Pre-commit (scripts/git-hooks/pre-commit, D-094): format and lint only the staged files. ESLint looks up each file's own
 * project config (`v10_config_lookup_from_file`), so app rules (no-literal-string) apply as in `nx lint`.
 */
const eslint = 'eslint --flag v10_config_lookup_from_file --fix --max-warnings=0 --no-warn-ignored';
// The locale files every ticket adds keys to are kept sorted (D-147).
const SORTED_LOCALES =
  /shared-i18n[\\/]src[\\/]locales[\\/][a-z]+[\\/](validation|errors|enums)\.json$/;
const quote = (files) => files.map((file) => JSON.stringify(file)).join(' ');

export default {
  // ESLint first: its fixes (import order, type imports) are then laid out by Prettier, as `format:check` expects.
  '*.{ts,tsx,js,jsx,mjs,cjs}': [eslint, 'prettier --write'],
  '*.css': ['prettier --write', 'stylelint --fix'],
  '*.{yml,yaml,html}': 'prettier --write',
  // One entry for JSON, so sorting and formatting a locale file run in order, never side by side.
  '*.json': (files) => {
    const locales = files.filter((file) => SORTED_LOCALES.test(file));
    return [
      ...(locales.length > 0 ? [`node scripts/sort-locales.mjs ${quote(locales)}`] : []),
      `prettier --write ${quote(files)}`,
    ];
  },
};
