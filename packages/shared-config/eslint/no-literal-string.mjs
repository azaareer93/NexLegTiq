import i18next from 'eslint-plugin-i18next';

/** JSX attributes that show text to the user (HTML and AntD). Everything else (`type`, `htmlType`, `rowKey`…) is technical. */
const USER_FACING_ATTRIBUTES = [
  'title',
  'placeholder',
  'alt',
  'aria-label',
  'aria-description',
  'label',
  'tooltip',
  'description',
  'message',
  'content',
  'extra',
  'help',
  'okText',
  'cancelText',
  'emptyText',
  'addonBefore',
  'addonAfter',
];

/**
 * Frontend text rules for the apps and shared-ui (frontend.md, D-087), spread into their eslint.config.mjs (paths are
 * relative to the project; tests and stories excluded): JSX text and user-facing attributes must come from `t()`, and
 * nothing is rendered as raw HTML
 * (`dangerouslySetInnerHTML` would turn interpolated user data into markup; i18next does not escape, React does).
 * **Not caught:** strings inside objects and calls (`columns={[{ title: '…' }]}`, `message.error('…')`) — reviews check those.
 */
export const noLiteralString = [
  {
    files: ['src/**/*.tsx'],
    // Tests and Storybook stories hold sample data, not product copy.
    ignores: ['src/**/*.{spec,test,stories}.tsx'],
    plugins: i18next.configs['flat/recommended'].plugins,
    rules: {
      'i18next/no-literal-string': [
        'error',
        { mode: 'jsx-only', 'jsx-attributes': { include: USER_FACING_ATTRIBUTES } },
      ],
      'react/no-danger': 'error',
    },
  },
];
