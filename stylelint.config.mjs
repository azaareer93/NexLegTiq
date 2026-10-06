/**
 * Stylesheets use logical properties only (frontend.md, MVP-29): `margin-inline-start`, not `margin-left`, so the Arabic (RTL)
 * layout mirrors by itself. Inline styles in TSX are checked by ESLint (`no-restricted-syntax` in shared-config).
 */
const PHYSICAL = [
  '/^(margin|padding)-(left|right)$/',
  '/^border-(left|right)(-.+)?$/',
  '/^border-(top|bottom)-(left|right)-radius$/',
  'left',
  'right',
];

export default {
  rules: {
    'property-disallowed-list': [
      PHYSICAL,
      { message: 'Use the logical property (…-inline-start / …-inline-end, inset-inline-…).' },
    ],
    'declaration-property-value-disallowed-list': [
      { '/^(text-align|float|clear)$/': ['left', 'right'] },
      { message: 'Use start / end (inline-start / inline-end) so RTL mirrors.' },
    ],
  },
};
