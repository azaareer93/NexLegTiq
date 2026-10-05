import type { Decorator, Preview } from '@storybook/react-vite';

import { NexProvider } from '../src/components/NexProvider';

/** Every story inside the app root, in the language (and so the direction) picked in the toolbar. */
const withNexProvider: Decorator = (Story, context) => (
  <NexProvider userLocale={context.globals['locale'] === 'en' ? 'en' : 'ar'}>
    <Story />
  </NexProvider>
);

const preview: Preview = {
  globalTypes: {
    locale: {
      description: 'Language and direction',
      toolbar: {
        title: 'Language',
        icon: 'globe',
        dynamicTitle: true,
        items: [
          { value: 'ar', title: 'العربية (RTL)' },
          { value: 'en', title: 'English (LTR)' },
        ],
      },
    },
  },
  initialGlobals: { locale: 'ar' },
  decorators: [withNexProvider],
  // Accessibility violations fail the story in the a11y panel (and in any Storybook test run).
  parameters: { a11y: { test: 'error' } },
};

export default preview;
