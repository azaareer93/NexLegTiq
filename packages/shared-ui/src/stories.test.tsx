import { SUPPORTED_LOCALES } from '@nexlegtiq/shared-types';
import { composeStories } from '@storybook/react-vite';
import type { Meta, StoryFn } from '@storybook/react-vite';
import { cleanup, render } from '@testing-library/react';
import axe from 'axe-core';

import * as sharedUi from './index';
import preview from '../.storybook/preview';

type StoryModule = { default: Meta } & Record<string, StoryFn>;

const modules = import.meta.glob<StoryModule>('./components/**/*.stories.tsx', { eager: true });
const sources = import.meta.glob<string>('./components/**/*.stories.tsx', {
  eager: true,
  query: '?raw',
  import: 'default',
});

// jsdom has no layout, so colour contrast cannot be measured here: the theme's contrast is tested in components.test.tsx
// and the Storybook a11y panel checks rendered components. Landmark regions belong to pages, not to components.
const AXE_OPTIONS: axe.RunOptions = {
  rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
};

/** Providers and wrappers that are shown inside every story rather than in their own. */
const NOT_VISUAL = [
  'NexProvider',
  'LanguageProvider',
  'PermissionsProvider',
  'FormatSettingsProvider',
  'Can',
];

// Composed with the real Storybook preview (its NexProvider decorator and Language toolbar), once per language.
const cases = SUPPORTED_LOCALES.flatMap((locale) =>
  Object.entries(modules).flatMap(([file, module]) =>
    Object.entries(composeStories(module, { ...preview, initialGlobals: { locale } })).map(
      ([name, Story]) =>
        [`${file.replace(/^.*\//, '')} › ${name} (${locale})`, Story, locale] as const,
    ),
  ),
);

/**
 * Every Storybook story is also a test (D-088): rendered in Arabic (RTL) and English (LTR) through the Storybook preview, it
 * must render without errors and pass axe. This replaces the browser-based Storybook test-runner in CI.
 */
describe('shared-ui stories', () => {
  afterEach(cleanup);

  it('should have a story for every component shared-ui exports', () => {
    const components = Object.entries(sharedUi)
      .filter(
        ([name, value]) =>
          typeof value === 'function' && /^[A-Z]/.test(name) && !NOT_VISUAL.includes(name),
      )
      .map(([name]) => name);
    const storySource = Object.values(sources).join('\n');
    expect(
      components.filter(
        (name) => !storySource.includes(`<${name}`) && !storySource.includes(`component: ${name}`),
      ),
    ).toEqual([]);
  });

  it.each(cases)('%s should render accessibly', async (_name, Story, locale) => {
    const { baseElement } = render(<Story />);
    expect(document.documentElement.getAttribute('dir')).toBe(locale === 'ar' ? 'rtl' : 'ltr');
    expect(document.documentElement.getAttribute('lang')).toBe(locale);
    const { violations } = await axe.run(baseElement, AXE_OPTIONS);
    expect(
      violations.map(
        (violation) =>
          `${violation.id} (${violation.help}): ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
      ),
    ).toEqual([]);
  });
});
