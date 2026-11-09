import type { AiSummaryListItem, Case, Document } from '@nexlegtiq/shared-contracts';
import { permissionsFor } from '@nexlegtiq/shared-types';
import type { Role } from '@nexlegtiq/shared-types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { HttpResponse } from 'msw';

import { sockets } from '../../test/fake-socket';
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
const ID = '01920000-0000-7000-8000-0000000001f1';
const LAWYER = '01920000-0000-7000-8000-0000000000a1';
const DOC_ID = '01920000-0000-7000-8000-0000000000d9';
const JOB = '01920000-0000-7000-8000-0000000000b1';

const FILE: Case = {
  id: ID,
  fileNumber: '2026-LIT-00007',
  title: 'Land dispute',
  fileType: 'LITIGATION',
  status: 'OPEN',
  priority: 'HIGH',
  openingDate: '2026-10-01',
  isConfidential: false,
  primaryClient: { id: '01920000-0000-7000-8000-0000000000c1', displayName: 'Omar Khalil' },
  responsibleLawyer: { id: LAWYER, fullName: 'Sami Nasser' },
  updatedAt: '2026-10-05T09:00:00.000Z',
  description: 'Boundary of the olive grove',
  subType: null,
  closingDate: null,
  responsibleParalegal: { id: '01920000-0000-7000-8000-0000000000a2', fullName: 'Rana Odeh' },
  courtCaseNumber: '123/2026',
  court: {
    id: '01920000-0000-7000-8000-0000000000d1',
    nameAr: 'محكمة بداية رام الله',
    nameEn: 'Ramallah Court of First Instance',
    courtType: 'FIRST_INSTANCE',
  },
  judge: { id: '01920000-0000-7000-8000-0000000000e1', fullName: 'Judge Hani' },
  jurisdiction: 'PALESTINE',
  billingMethod: 'HOURLY',
  hourlyRate: '150.00',
  fixedFee: null,
  retainerBalance: '500.00',
  currency: 'ILS',
  clients: [
    {
      id: '01920000-0000-7000-8000-0000000000c1',
      displayName: 'Omar Khalil',
      clientType: 'INDIVIDUAL',
      isPrimary: true,
    },
  ],
  team: [
    { id: LAWYER, fullName: 'Sami Nasser', role: 'RESPONSIBLE_LAWYER' },
    { id: '01920000-0000-7000-8000-0000000000a2', fullName: 'Rana Odeh', role: 'PARALEGAL' },
  ],
  counts: { parties: 2, notes: 3 },
  createdAt: '2026-10-01T09:00:00.000Z',
};

const DOC: Document = {
  id: DOC_ID,
  fileId: ID,
  folderId: null,
  sessionId: null,
  name: 'Lease.pdf',
  originalFilename: 'Lease.pdf',
  documentType: 'EVIDENCE',
  mimeType: 'application/pdf',
  sizeBytes: 1000,
  currentVersion: 1,
  status: 'READY',
  ocrStatus: 'DONE',
  processingErrorCode: null,
  language: 'EN',
  isConfidential: false,
  sharedWithClient: false,
  uploadedBy: { id: LAWYER, fullName: 'Sami Nasser' },
  createdAt: '2026-10-02T09:00:00.000Z',
  updatedAt: '2026-10-03T09:00:00.000Z',
};

const summary = (n: number, extra: Partial<AiSummaryListItem> = {}): AiSummaryListItem => ({
  id: `01920000-0000-7000-8000-00000000011${n}`,
  sourceType: 'DOCUMENT',
  sourceId: DOC_ID,
  fileId: ID,
  versionNumber: 1,
  language: 'EN',
  summary: 'A lease dispute over unpaid rent.',
  keyFacts: ['Rent unpaid since May'],
  keyLegalIssues: ['Eviction grounds'],
  parties: ['Omar Khalil'],
  dates: [{ date: '2026-01-01', event: 'Lease start' }],
  provider: 'fake',
  model: 'fake-model-1',
  promptVersion: 'document-summary.v1',
  chunks: 1,
  createdAt: '2026-11-09T09:00:00.000Z',
  source: { type: 'DOCUMENT', id: DOC_ID, name: 'Lease.pdf', isConfidential: false },
  ...extra,
});

const USAGE = { used: 2, quota: 5, remaining: 3, resetsAt: '2026-12-01T00:00:00.000Z' };
const JOB_DONE = {
  id: JOB,
  type: 'summarize-document',
  status: 'SUCCEEDED',
  sourceType: 'DOCUMENT',
  sourceId: DOC_ID,
  errorCode: null,
  result: null,
  createdAt: '2026-11-09T09:00:00.000Z',
  updatedAt: '2026-11-09T09:00:05.000Z',
  finishedAt: '2026-11-09T09:00:05.000Z',
};

const documentPage = HttpResponse.json({
  success: true,
  data: [DOC],
  meta: {
    timestamp: '2026-11-09T10:00:00.000Z',
    requestId: 'req-12345678',
    pagination: { page: 1, limit: 100, total: 1, totalPages: 1, hasMore: false },
  },
});

function serve(state: { items: AiSummaryListItem[] }) {
  const posted: Record<string, unknown>[] = [];
  const notes: unknown[] = [];
  const feedback: unknown[] = [];
  server.use(
    http.get(api(`cases/${ID}`), () => ok(FILE)),
    http.get(api(`cases/${ID}/documents`), () => documentPage.clone()),
    http.get(api('ai/summaries'), () => ok(state.items)),
    http.get(api('ai/usage'), () => ok(USAGE)),
    http.post(api('ai/summaries'), async ({ request }) => {
      posted.push((await request.json()) as Record<string, unknown>);
      return ok({ jobId: JOB, status: 'QUEUED' }, 202);
    }),
    http.post(api(`cases/${ID}/notes`), async ({ request }) => {
      notes.push(await request.json());
      return ok({}, 201);
    }),
    http.post(api('ai/summaries/:id/feedback'), async ({ request }) => {
      feedback.push(await request.json());
      return ok({ id: JOB }, 201);
    }),
  );
  return { posted, notes, feedback };
}

function signIn(locale: 'en' | 'ar', role: Role = 'OFFICE_MANAGER') {
  setViewport(1280);
  signedIn({
    id: USER.id,
    role,
    uiLanguage: locale === 'ar' ? 'AR' : 'EN',
    permissions: [...permissionsFor(role)],
  });
  renderApp(`/cases/${ID}?tab=ai`, locale);
}

async function openAi(locale: 'en' | 'ar' = 'en', role: Role = 'OFFICE_MANAGER') {
  signIn(locale, role);
  return screen.findByTestId('ai-tab', {}, { timeout: COLD });
}

const emit = (event: string, payload: unknown) => {
  const socket = sockets[sockets.length - 1];
  for (const handler of socket?.anyHandlers ?? []) handler(event, payload);
};

async function pickDocument(tab: HTMLElement) {
  const picker = within(await within(tab).findByTestId('ai-document')).getByRole('combobox');
  fireEvent.mouseDown(picker);
  const option = await screen.findByText('Lease.pdf', {
    selector: '.ant-select-item-option-content *',
  });
  fireEvent.click(option);
}

const summaryText = (tab: HTMLElement) =>
  within(tab).findByText('A lease dispute over unpaid rent.', {}, { timeout: COLD });

describe('AI tab (D-148)', () => {
  it(
    'should list summaries with the disclaimer on every card and the quota badge',
    async () => {
      serve({ items: [summary(1), summary(2, { language: 'AR' })] });
      const tab = await openAi();
      expect(
        (
          await within(tab).findAllByText(
            'A lease dispute over unpaid rent.',
            {},
            { timeout: COLD },
          )
        ).length,
      ).toBe(2);
      expect(within(tab).getAllByText('Rent unpaid since May')).toHaveLength(2);
      expect(within(tab).getByTestId('ai-quota').textContent).toContain('2 of 5');
      expect(within(tab).getAllByTestId('ai-disclaimer')).toHaveLength(2);
      expect(within(tab).queryByTestId('ai-upgrade')).toBeNull();
    },
    SLOW,
  );

  it(
    'should show the disclaimer on the empty state too',
    async () => {
      serve({ items: [] });
      const tab = await openAi();
      expect(await within(tab).findByText('No summaries yet', {}, { timeout: COLD })).toBeTruthy();
      expect(within(tab).getAllByTestId('ai-disclaimer')).toHaveLength(1);
    },
    SLOW,
  );

  it(
    'should generate, show the pending card and finish when the job completes',
    async () => {
      const state = { items: [] as AiSummaryListItem[] };
      const calls = serve(state);
      let done = false;
      server.use(
        http.get(api(`jobs/${JOB}`), () =>
          ok(done ? JOB_DONE : { ...JOB_DONE, status: 'RUNNING', finishedAt: null }),
        ),
      );
      const tab = await openAi();
      await pickDocument(tab);
      fireEvent.click(within(tab).getByTestId('ai-generate'));
      const pendingCard = await within(tab).findByTestId(
        `ai-pending-${JOB}`,
        {},
        { timeout: COLD },
      );
      expect(within(pendingCard).getByTestId('ai-disclaimer')).toBeTruthy();
      expect(calls.posted[0]).toMatchObject({ sourceId: DOC_ID, language: 'AR', force: false });

      done = true;
      state.items = [summary(1)];
      emit('ai.job.completed', { jobId: JOB });
      expect(await summaryText(tab)).toBeTruthy();
      await waitFor(() => expect(within(tab).queryByTestId(`ai-pending-${JOB}`)).toBeNull());
      expect(within(tab).getAllByTestId('ai-disclaimer')).toHaveLength(1);
    },
    SLOW,
  );

  it(
    'should show a failed job with its error until dismissed, and regenerate with force',
    async () => {
      const calls = serve({ items: [summary(1)] });
      server.use(
        http.get(api(`jobs/${JOB}`), () =>
          ok({ ...JOB_DONE, status: 'FAILED', errorCode: 'AI-001' }),
        ),
      );
      const tab = await openAi();
      fireEvent.click(
        await within(tab).findByTestId(`ai-regenerate-${summary(1).id}`, {}, { timeout: COLD }),
      );
      const failed = await within(tab).findByTestId(`ai-failed-${JOB}`, {}, { timeout: COLD });
      expect(within(failed).getAllByRole('alert').length).toBeGreaterThan(0);
      expect(within(failed).getByTestId('ai-disclaimer')).toBeTruthy();
      expect(calls.posted[0]).toMatchObject({ force: true, language: 'EN', sourceId: DOC_ID });
      fireEvent.click(within(failed).getByTestId(`ai-dismiss-${JOB}`));
      await waitFor(() => expect(within(tab).queryByTestId(`ai-failed-${JOB}`)).toBeNull());
    },
    SLOW,
  );

  it(
    'should generate the other language without force',
    async () => {
      const calls = serve({ items: [summary(1)] });
      const tab = await openAi();
      fireEvent.click(
        await within(tab).findByTestId(`ai-switch-${summary(1).id}`, {}, { timeout: COLD }),
      );
      await waitFor(() => expect(calls.posted).toHaveLength(1));
      expect(calls.posted[0]).toMatchObject({ language: 'AR', force: false });
    },
    SLOW,
  );

  it(
    'should post the reason of a report',
    async () => {
      const calls = serve({ items: [summary(1)] });
      const tab = await openAi();
      fireEvent.click(
        await within(tab).findByTestId(`ai-report-${summary(1).id}`, {}, { timeout: COLD }),
      );
      const picker = within(await screen.findByTestId('ai-feedback-reason')).getByRole('combobox');
      fireEvent.mouseDown(picker);
      fireEvent.click(await screen.findByText('Inaccurate'));
      fireEvent.change(screen.getByTestId('ai-feedback-comment'), {
        target: { value: 'Wrong amount' },
      });
      fireEvent.click(screen.getByTestId('ai-feedback-submit'));
      await waitFor(() => expect(calls.feedback).toHaveLength(1));
      expect(calls.feedback[0]).toEqual({ reason: 'INACCURATE', comment: 'Wrong amount' });
    },
    SLOW,
  );

  it(
    'should copy a summary into a plain, non-confidential note',
    async () => {
      const calls = serve({ items: [summary(1)] });
      const tab = await openAi();
      fireEvent.click(
        await within(tab).findByTestId(`ai-copy-${summary(1).id}`, {}, { timeout: COLD }),
      );
      await waitFor(() => expect(calls.notes).toHaveLength(1));
      const note = calls.notes[0] as { body: string; isConfidential: boolean };
      expect(note.isConfidential).toBe(false);
      expect(note.body).toContain('A lease dispute over unpaid rent.');
      expect(note.body).toContain('- Rent unpaid since May');
    },
    SLOW,
  );

  it(
    'should hint at an upgrade when the quota is reached',
    async () => {
      serve({ items: [] });
      server.use(http.post(api('ai/summaries'), () => fail(403, 'AUTH-103')));
      const tab = await openAi();
      await pickDocument(tab);
      fireEvent.click(within(tab).getByTestId('ai-generate'));
      expect(await within(tab).findByTestId('ai-upgrade', {}, { timeout: COLD })).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should copy the summary of a confidential document as a confidential note',
    async () => {
      const confidential = summary(1, {
        source: { type: 'DOCUMENT', id: DOC_ID, name: 'Lease.pdf', isConfidential: true },
      });
      const calls = serve({ items: [confidential] });
      const tab = await openAi();
      fireEvent.click(
        await within(tab).findByTestId(`ai-copy-${confidential.id}`, {}, { timeout: COLD }),
      );
      await waitFor(() => expect(calls.notes).toHaveLength(1));
      expect(calls.notes[0]).toMatchObject({ isConfidential: true });
    },
    SLOW,
  );

  it(
    'should hide copy-to-note for a confidential summary when the user may not write confidential notes',
    async () => {
      const confidential = summary(1, {
        source: { type: 'DOCUMENT', id: DOC_ID, name: 'Lease.pdf', isConfidential: true },
      });
      const open = summary(2);
      serve({ items: [confidential, open] });
      const tab = await openAi('en', 'SENIOR_LAWYER');
      await within(tab).findByTestId(`ai-report-${confidential.id}`, {}, { timeout: COLD });
      expect(within(tab).queryByTestId(`ai-copy-${confidential.id}`)).toBeNull();
      expect(within(tab).getByTestId(`ai-copy-${open.id}`)).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should offer no copy-to-note without edit rights on the file',
    async () => {
      serve({ items: [summary(1)] });
      const tab = await openAi('en', 'LAWYER');
      await within(tab).findByTestId(`ai-report-${summary(1).id}`, {}, { timeout: COLD });
      expect(within(tab).queryByTestId(`ai-copy-${summary(1).id}`)).toBeNull();
    },
    SLOW,
  );

  it(
    'should explain a missing feedback reason in the user language',
    async () => {
      serve({ items: [summary(1)] });
      const tab = await openAi('ar');
      fireEvent.click(
        await within(tab).findByTestId(`ai-report-${summary(1).id}`, {}, { timeout: COLD }),
      );
      fireEvent.click(await screen.findByTestId('ai-feedback-submit'));
      expect(await screen.findByText('هذا الحقل مطلوب.')).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should show only a notice when AI is turned off for the office',
    async () => {
      serve({ items: [] });
      server.use(http.get(api('ai/usage'), () => fail(403, 'AI-005')));
      signIn('en');
      expect(await screen.findByTestId('ai-disabled', {}, { timeout: COLD })).toBeTruthy();
      expect(screen.queryByTestId('ai-generate')).toBeNull();
    },
    SLOW,
  );

  it.each(['en', 'ar'] as const)(
    'should have no accessibility violations in %s',
    async (locale) => {
      serve({ items: [summary(1, { language: locale === 'ar' ? 'AR' : 'EN' })] });
      const tab = await openAi(locale);
      await within(tab).findByTestId('ai-disclaimer', {}, { timeout: COLD });
      const results = await axe.run(tab, {
        rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
      });
      expect(results.violations.map((v) => v.id)).toEqual([]);
    },
    SLOW,
  );
});
