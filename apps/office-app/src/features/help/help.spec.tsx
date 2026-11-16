import { RESOURCES } from '@nexlegtiq/shared-i18n';
import { permissionsFor } from '@nexlegtiq/shared-types';
import { fireEvent, screen } from '@testing-library/react';
import axe from 'axe-core';

import { HELP_ARTICLES, HELP_SLUGS, bugReportHref } from './articles';
import { renderApp, setupTestServer, setViewport, signedIn } from '../../test/render-app';

setupTestServer();
const COLD = 20_000;
const SLOW = 60_000;

function open(path: string, locale: 'en' | 'ar' = 'en') {
  setViewport(1280);
  signedIn({
    role: 'LAWYER',
    uiLanguage: locale === 'ar' ? 'AR' : 'EN',
    permissions: [...permissionsFor('LAWYER')],
  });
  renderApp(path, locale);
}

describe('help articles (D-185)', () => {
  it('should have a title, summary, body and steps for every article in both languages', () => {
    for (const locale of ['en', 'ar'] as const) {
      const articles = (
        RESOURCES[locale].help as { articles: Record<string, Record<string, string>> }
      ).articles;
      for (const slug of HELP_SLUGS) {
        const article = articles[HELP_ARTICLES[slug]];
        for (const field of ['title', 'summary', 'body', 'steps']) {
          expect(article?.[field]?.trim(), `${locale} ${slug} ${field}`).toBeTruthy();
        }
      }
    }
  });

  it('should write a bug report with the page and language but no data', () => {
    const href = bugReportHref('support@example.test', 'Problem', 'ar');
    expect(href.startsWith('mailto:support@example.test?subject=Problem&body=')).toBe(true);
    expect(decodeURIComponent(href)).toContain('Language: ar');
  });
});

describe('Help Center (MVP-119)', () => {
  it(
    'should list every guide, open one with its steps, and go back',
    { timeout: SLOW },
    async () => {
      open('/help');
      const list = await screen.findByTestId('help-articles', {}, { timeout: COLD });
      expect(list.querySelectorAll('[data-testid^="help-article-"]')).toHaveLength(
        HELP_SLUGS.length,
      );
      expect(screen.getByTestId('help-contact').textContent).toContain('not been set up');
      fireEvent.click(screen.getByTestId('help-article-hearings'));
      const steps = await screen.findByTestId('help-steps', {}, { timeout: COLD });
      expect(steps.querySelectorAll('li').length).toBeGreaterThan(1);
      fireEvent.click(screen.getByTestId('help-back'));
      expect(await screen.findByTestId('page-help', {}, { timeout: COLD })).toBeTruthy();
    },
  );

  it('should say so for a guide that does not exist', { timeout: SLOW }, async () => {
    open('/help/nope');
    expect(
      await screen.findByText('This guide does not exist.', {}, { timeout: COLD }),
    ).toBeTruthy();
  });

  it('should open the guide of a page from its "?"', { timeout: SLOW }, async () => {
    open('/tasks');
    fireEvent.click(await screen.findByTestId('help-link-tasks', {}, { timeout: COLD }));
    expect(
      (await screen.findByTestId('page-help-article', {}, { timeout: COLD })).textContent,
    ).toContain('Tasks');
  });

  it('should be accessible in Arabic', { timeout: SLOW }, async () => {
    open('/help/ai-summaries', 'ar');
    await screen.findByTestId('page-help-article', {}, { timeout: COLD });
    expect(document.documentElement.dir).toBe('rtl');
    const { violations } = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(violations.map((v) => v.id)).toEqual([]);
  });
});
