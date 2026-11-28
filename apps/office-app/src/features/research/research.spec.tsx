import type { LegalResearch } from '@nexlegtiq/shared-contracts';
import { permissionsFor } from '@nexlegtiq/shared-types';
import type { Role } from '@nexlegtiq/shared-types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';

import {
  api,
  fail,
  http,
  ok,
  renderApp,
  server,
  setupTestServer,
  setViewport,
  signedIn,
  USER,
} from '../../test/render-app';

setupTestServer();

const COLD = 20_000;
const SLOW = 60_000;
const JOB = '01920000-0000-7000-8000-0000000000b1';
const NOW = '2026-11-27T09:00:00.000Z';

const RESEARCH: LegalResearch = {
  answer: 'One month in writing.',
  citations: [
    {
      url: 'https://muqtafi.birzeit.edu/law/9',
      title: 'Labour Law No. 7 of 2000',
      date: '2000-04-30',
    },
  ],
  jurisdictionNote: 'Applies in the West Bank.',
  unsourced: false,
  jurisdiction: 'PALESTINE',
  language: 'EN',
  provider: 'fake',
  model: 'fake-1',
  promptVersion: 'legal-research.v1',
  createdAt: NOW,
};

function serve(research: LegalResearch = RESEARCH) {
  const posted: unknown[] = [];
  server.use(
    http.post(api('ai/research'), async ({ request }) => {
      posted.push(await request.json());
      return ok({ jobId: JOB, status: 'QUEUED' }, 202);
    }),
    http.get(api(`jobs/${JOB}`), () =>
      ok({
        id: JOB,
        type: 'legal-research',
        status: 'SUCCEEDED',
        sourceType: null,
        sourceId: null,
        errorCode: null,
        result: { citations: research.citations.length },
        createdAt: NOW,
        updatedAt: NOW,
        finishedAt: NOW,
      }),
    ),
    http.get(api(`ai/research/${JOB}`), () => ok(research)),
  );
  return posted;
}

async function open(locale: 'en' | 'ar' = 'en', role: Role = 'LAWYER') {
  setViewport(1280);
  signedIn({
    id: USER.id,
    role,
    uiLanguage: locale === 'ar' ? 'AR' : 'EN',
    permissions: [...permissionsFor(role)],
  });
  renderApp('/research', locale);
  return screen.findByTestId('research-question', {}, { timeout: COLD });
}

async function askQuestion(text = 'What notice period applies to ending a work contract?') {
  fireEvent.change(await open(), { target: { value: text } });
  fireEvent.click(screen.getByTestId('research-submit'));
}

describe('Legal research page (D-256)', () => {
  it(
    'should queue the question, follow the job and show the answer with its sources and the disclaimer',
    async () => {
      const posted = serve();
      await askQuestion();
      const answer = await screen.findByTestId('research-answer', {}, { timeout: COLD });
      await waitFor(() =>
        expect(posted).toEqual([
          { question: 'What notice period applies to ending a work contract?', language: 'EN' },
        ]),
      );
      expect(within(answer).getByText('One month in writing.')).toBeTruthy();
      expect(within(answer).getByTestId('ai-disclaimer')).toBeTruthy();
      const link = within(answer).getByRole('link', { name: 'Labour Law No. 7 of 2000' });
      expect(link.getAttribute('href')).toBe('https://muqtafi.birzeit.edu/law/9');
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(within(answer).queryByTestId('research-unsourced')).toBeNull();
    },
    SLOW,
  );

  it(
    'should label an answer without sources as unsourced',
    async () => {
      serve({ ...RESEARCH, citations: [], unsourced: true });
      await askQuestion();
      const answer = await screen.findByTestId('research-answer', {}, { timeout: COLD });
      expect(within(answer).getByTestId('research-unsourced').textContent).toBe('Unsourced');
      expect(within(answer).queryByTestId('research-sources')).toBeNull();
    },
    SLOW,
  );

  it(
    'should explain when research is not available',
    async () => {
      server.use(http.post(api('ai/research'), () => fail(503, 'AI-001')));
      await askQuestion();
      expect(
        await screen.findByText(/The AI service is unavailable right now/, {}, { timeout: COLD }),
      ).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should not offer the page to a role without use:ai',
    async () => {
      setViewport(1280);
      signedIn({
        id: USER.id,
        role: 'EXTERNAL_COLLABORATOR',
        permissions: [...permissionsFor('EXTERNAL_COLLABORATOR')],
      });
      renderApp('/research');
      expect(await screen.findByTestId('page-forbidden', {}, { timeout: COLD })).toBeTruthy();
      expect(screen.queryByTestId('research-question')).toBeNull();
    },
    SLOW,
  );

  it.each(['en', 'ar'] as const)(
    'should have no accessibility violations in %s',
    async (locale) => {
      serve({ ...RESEARCH, language: locale === 'ar' ? 'AR' : 'EN' });
      fireEvent.change(await open(locale), { target: { value: 'سؤال عن مدة الإشعار' } });
      fireEvent.click(screen.getByTestId('research-submit'));
      await screen.findByTestId('research-answer', {}, { timeout: COLD });
      expect(document.documentElement.dir).toBe(locale === 'ar' ? 'rtl' : 'ltr');
      const results = await axe.run(document.body, {
        rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
      });
      expect(results.violations.map((v) => v.id)).toEqual([]);
    },
    SLOW,
  );
});
