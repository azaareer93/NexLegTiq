import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { aiApi } from './ai.js';
import { createApiClient } from './api-client.js';

const ORIGIN = 'http://api.test';
const url = (path: string) => `${ORIGIN}/api/v1/${path}`;
const meta = { timestamp: '2026-11-09T10:00:00.000Z', requestId: 'req-12345678' };
const ok = (data: unknown, status = 200) =>
  HttpResponse.json({ success: true, data, meta }, { status });
const DOC = '01920000-0000-7000-8000-0000000000d1';
const FILE = '01920000-0000-7000-8000-0000000000f1';
const SUMMARY = {
  id: '01920000-0000-7000-8000-0000000000a1',
  sourceType: 'DOCUMENT',
  sourceId: DOC,
  fileId: FILE,
  versionNumber: 1,
  language: 'EN',
  summary: 'A lease dispute.',
  keyFacts: ['Rent unpaid'],
  keyLegalIssues: ['Eviction'],
  parties: ['Omar'],
  dates: [{ date: '2026-01-01', event: 'Lease start' }],
  provider: 'fake',
  model: 'fake-1',
  promptVersion: 'document-summary.v1',
  chunks: 1,
  createdAt: '2026-11-09T09:00:00.000Z',
};
const JOB = '01920000-0000-7000-8000-0000000000b1';

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = () =>
  aiApi(
    createApiClient({
      baseURL: ORIGIN,
      realm: 'office',
      getToken: () => 'access-1',
      setToken: () => undefined,
      onAuthFailure: () => undefined,
    }),
  );

describe('aiApi (D-148)', () => {
  it('should list by file and by document', async () => {
    const queries: string[] = [];
    server.use(
      http.get(url('ai/summaries'), ({ request }) => {
        queries.push(new URL(request.url).search);
        return ok(
          queries.length === 1
            ? [{ ...SUMMARY, source: { type: 'DOCUMENT', id: DOC, name: 'a.pdf' } }]
            : [SUMMARY],
        );
      }),
    );
    await expect(api().byFile(FILE)).resolves.toHaveLength(1);
    await expect(api().byDocument(DOC)).resolves.toEqual([SUMMARY]);
    expect(queries[0]).toBe(`?fileId=${FILE}`);
    expect(queries[1]).toBe(`?sourceType=DOCUMENT&sourceId=${DOC}`);
  });

  it('should tell a stored summary from a queued job and send force', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(url('ai/summaries'), async ({ request }) => {
        const body = (await request.json()) as { force?: boolean };
        bodies.push(body);
        return body.force ? ok({ jobId: JOB, status: 'QUEUED' }, 202) : ok(SUMMARY);
      }),
    );
    await expect(
      api().request({ sourceType: 'DOCUMENT', sourceId: DOC, language: 'EN', force: false }),
    ).resolves.toMatchObject({ id: SUMMARY.id });
    await expect(
      api().request({ sourceType: 'DOCUMENT', sourceId: DOC, language: 'EN', force: true }),
    ).resolves.toEqual({ jobId: JOB, status: 'QUEUED' });
    expect(bodies[1]).toMatchObject({ force: true });
  });

  it('should post feedback and read a job and the usage', async () => {
    let feedback: unknown;
    server.use(
      http.post(url(`ai/summaries/${SUMMARY.id}/feedback`), async ({ request }) => {
        feedback = await request.json();
        return ok({ id: JOB }, 201);
      }),
      http.get(url(`jobs/${JOB}`), () =>
        ok({
          id: JOB,
          type: 'summarize-document',
          status: 'FAILED',
          sourceType: 'DOCUMENT',
          sourceId: DOC,
          errorCode: 'AI-001',
          result: null,
          createdAt: '2026-11-09T09:00:00.000Z',
          updatedAt: '2026-11-09T09:00:01.000Z',
          finishedAt: '2026-11-09T09:00:01.000Z',
        }),
      ),
      http.get(url('ai/usage'), () =>
        ok({ used: 2, quota: 5, remaining: 3, resetsAt: '2026-12-01T00:00:00.000Z' }),
      ),
    );
    await expect(
      api().feedback(SUMMARY.id, { reason: 'INACCURATE', comment: 'x' }),
    ).resolves.toEqual({ id: JOB });
    expect(feedback).toEqual({ reason: 'INACCURATE', comment: 'x' });
    await expect(api().job(JOB)).resolves.toMatchObject({ errorCode: 'AI-001' });
    await expect(api().usage()).resolves.toMatchObject({ remaining: 3 });
  });
});
