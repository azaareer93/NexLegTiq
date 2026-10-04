import i18next from 'eslint-plugin-i18next';

/**
 * No user-facing literal strings in app code (frontend.md, MVP-44): JSX text and JSX attribute values must come from
 * `t()`. Technical attributes are allowed. Spread into each app's eslint.config.mjs; paths are relative to the app.
 */
export const noLiteralString = [
  {
    files: ['src/**/*.tsx'],
    ignores: ['src/**/*.{spec,test}.tsx'],
    plugins: i18next.configs['flat/recommended'].plugins,
    rules: {
      'i18next/no-literal-string': [
        'error',
        {
          mode: 'jsx-only',
          'jsx-attributes': {
            exclude: [
              'className',
              'style',
              'type',
              'key',
              'id',
              'width',
              'height',
              'data-testid',
              'lang',
              'dir',
              'role',
              'to',
              'href',
              'rel',
              'target',
              'htmlFor',
              'name',
              'autoComplete',
              'inputMode',
              'variant',
              'size',
              'shape',
              'placement',
              'layout',
              'mode',
              'theme',
            ],
          },
        },
      ],
    },
  },
];
