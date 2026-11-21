import * as Sentry from '@sentry/node';
import type { ErrorEvent } from '@sentry/node';

import { initErrorReporting, reportError, scrubEvent } from './error-reporting';
import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';
import { DependencyUnavailableException } from '../errors/app.exception';

jest.mock('@sentry/node');

const config = (env: Record<string, string> = {}) => new AppConfig(parseEnv(testEnv(env)));

describe('error reporting (D-230)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should stay off without a DSN', () => {
    expect(initErrorReporting(config(), 'api')).toBe(false);
    expect(Sentry.initWithoutDefaultIntegrations).not.toHaveBeenCalled();
  });

  it('should start without default integrations, data collection or breadcrumbs when a DSN is set', () => {
    const dsn = 'https://key@o1.ingest.de.sentry.io/2';
    expect(
      initErrorReporting(config({ SENTRY_DSN: dsn, SENTRY_ENVIRONMENT: 'staging' }), 'worker'),
    ).toBe(true);
    expect(Sentry.initWithoutDefaultIntegrations).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn,
        environment: 'staging',
        dataCollection: expect.objectContaining({ userInfo: false, httpBodies: [] }),
        maxBreadcrumbs: 0,
        initialScope: { tags: { process: 'worker' } },
        beforeSend: scrubEvent,
      }),
    );
  });

  it('should refuse a DSN that is not https', () => {
    expect(() => config({ SENTRY_DSN: 'http://key@sentry.local/2' })).toThrow();
  });

  it('should drop request data, user, breadcrumbs and extra from every event', () => {
    const event = {
      type: undefined,
      exception: { values: [{ type: 'Error', value: 'boom' }] },
      tags: { requestId: 'req-1' },
      request: { data: '{"password":"x"}', headers: { cookie: 'sid=1' }, query_string: 't=1' },
      user: { email: 'a@b.c', ip_address: '1.2.3.4' },
      breadcrumbs: [{ message: 'GET /invites/secret' }],
      extra: { body: 'client data' },
    } as ErrorEvent;

    expect(scrubEvent(event)).toEqual({
      type: undefined,
      exception: event.exception,
      tags: event.tags,
    });
  });

  it('should report a Prisma error by its code, without the message that quotes query arguments', () => {
    const error = Object.assign(new Error('Unique failed on {"email":"a@b.c"}'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
    });

    reportError(error, { requestId: 'req-1', jobId: undefined });

    const [reported, hint] = jest.mocked(Sentry.captureException).mock.calls[0] ?? [];
    expect(JSON.stringify([reported, (reported as Error).stack, hint])).not.toContain('a@b.c');
    expect((reported as Error).message).toBe('P2002');
    expect(hint).toEqual({ tags: { requestId: 'req-1', prismaCode: 'P2002' } });
  });

  it('should never send the original error object with its properties', () => {
    const error = Object.assign(new Error('boom'), {
      body: 'client data',
      config: { apiKey: 'k' },
    });

    reportError(error, { code: 'SYS-001' });

    const [reported] = jest.mocked(Sentry.captureException).mock.calls[0] ?? [];
    expect(reported).not.toBe(error);
    expect(reported).not.toHaveProperty('body');
    expect(reported).not.toHaveProperty('config');
  });

  it('should drop the message of a library error, which can quote document text, but keep its frames', () => {
    let error: unknown;
    try {
      JSON.parse('{"summary": "the client confessed');
    } catch (caught) {
      error = caught;
    }

    reportError(error, {});

    const [reported] = jest.mocked(Sentry.captureException).mock.calls[0] ?? [];
    const { name, message, stack } = reported as Error;
    expect({ name, message }).toEqual({ name: 'SyntaxError', message: 'SyntaxError' });
    expect(stack).not.toContain('confessed');
    expect(stack).toMatch(/^SyntaxError: SyntaxError\n\s+at /);
  });

  it('should keep the developer-written message of our own exceptions', () => {
    reportError(new DependencyUnavailableException([]), {});

    const [reported] = jest.mocked(Sentry.captureException).mock.calls[0] ?? [];
    expect((reported as Error).message).toBe('Service unavailable');
  });
});
