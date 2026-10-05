import { SUPPORTED_LOCALES } from '@nexlegtiq/shared-types';
import { composeStories } from '@storybook/react-vite';
import type { Meta, StoryFn } from '@storybook/react-vite';
import { cleanup, render } from '@testing-library/react';
import axe from 'axe-core';

import { NexProvider } from './components/NexProvider';

type StoryModule = { default: Meta } & Record<string, StoryFn>;

const modules = import.meta.glob<StoryModule>('./components/**/*.stories.tsx', { eager: true });

// jsdom has no layout: colour contrast is checked in Storybook's a11y panel, landmark regions belong to pages, not parts.
const AXE_OPTIONS: axe.RunOptions = { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } };

const cases = Object.entries(modules).flatMap(([file, module]) =>
  Object.entries(composeStories(module)).flatMap(([name, Story]) =>
    SUPPORTED_LOCALES.map((locale) => [`${file.replace(/^.*\//, '')} › ${name} (${locale})`, Story, locale] as const),
  ),
);

/**
 * Every Storybook story is also a test (D-088): rendered in Arabic (RTL) and English (LTR) inside the app root, it must render
 * without errors and pass axe. This replaces the browser-based Storybook test-runner in CI.
 */
describe('shared-ui stories', () => {
  afterEach(cleanup);

  it('should find the stories', () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });

  it.each(cases)('%s should render accessibly', async (_name, Story, locale) => {
    const { baseElement } = render(
      <NexProvider userLocale={locale}>
        <Story />
      </NexProvider>,
    );
    expect(document.documentElement.getAttribute('dir')).toBe(locale === 'ar' ? 'rtl' : 'ltr');
    const { violations } = await axe.run(baseElement, AXE_OPTIONS);
    expect(violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([]);
  });
});
