import { UnrecoverableError } from 'bullmq';
import nodemailer from 'nodemailer';

import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';
import type { QueueProducer } from '../queue/queue-producer';
import { MailService, SEND_EMAIL_JOB } from './mail.service';
import { MailTransport } from './mail-transport';
import { duration, MAIL_TEMPLATE_NAMES, MAIL_TEMPLATE_SCHEMAS, renderMail } from './templates';

const APP = 'https://app.example.test';
const config = (env: Record<string, string> = {}) =>
  new AppConfig(parseEnv(testEnv({ NODE_ENV: 'development', ...env })));
const VARS = {
  name: 'عمر',
  officeName: 'مكتب',
  inviterName: 'سارة',
  link: `${APP}/x?token=abc`,
  days: 7,
  minutes: 60,
};
const varsFor = (template: (typeof MAIL_TEMPLATE_NAMES)[number]) =>
  MAIL_TEMPLATE_SCHEMAS[template].parse(VARS) as never;

describe('duration', () => {
  it.each([
    [1, 'day', 'يوم واحد'],
    [2, 'day', 'يومين'],
    [7, 'day', '7 أيام'],
    [14, 'day', '14 يومًا'],
    [100, 'day', '100 يوم'],
    [1, 'minute', 'دقيقة واحدة'],
    [2, 'minute', 'دقيقتين'],
    [5, 'minute', '5 دقائق'],
    [60, 'minute', '60 دقيقة'],
  ] as const)('should say %s %s in Arabic as "%s"', (value, unit, expected) => {
    expect(duration(value, unit, 'AR')).toBe(expected);
  });

  it('should pluralise English', () => {
    expect(duration(1, 'day', 'EN')).toBe('1 day');
    expect(duration(7, 'day', 'EN')).toBe('7 days');
    expect(duration(60, 'minute', 'EN')).toBe('60 minutes');
  });
});

describe('renderMail', () => {
  it.each(MAIL_TEMPLATE_NAMES)(
    'should render %s in Arabic (rtl) and English (ltr) with fallback and legal links',
    (template) => {
      const ar = renderMail(template, 'AR', varsFor(template), APP);
      const en = renderMail(template, 'EN', varsFor(template), APP);

      expect(ar.html).toContain('<html lang="ar" dir="rtl">');
      expect(ar.html).toContain('lang="ar" dir="rtl" style=');
      expect(ar.html).toContain('text-align:right');
      expect(ar.html).toContain('font-family:Tahoma');
      expect(ar.html).toContain('إذا لم يعمل الزر');
      expect(en.html).toContain('<html lang="en" dir="ltr">');
      expect(en.html).toContain('text-align:left');
      expect(en.html).toContain('If the button does not work');
      for (const mail of [ar, en]) {
        expect(mail.subject.length).toBeGreaterThan(5);
        // Handlebars encodes '=' in attribute values; browsers decode it.
        expect(mail.html).toContain(`href="${APP}/x?token&#x3D;abc"`);
        expect(mail.html).toContain(
          `<bdi dir="ltr" style="word-break:break-all;">${APP}/x?token&#x3D;abc</bdi>`,
        );
        expect(mail.html).toContain(`${APP}/legal/terms`);
        expect(mail.html).toContain(`${APP}/legal/privacy`);
        expect(mail.text).toContain(`${APP}/x?token=abc`);
      }
    },
  );

  it('should isolate user values: <bdi> in HTML, isolate marks in subject and text', () => {
    const mail = renderMail(
      'invite',
      'AR',
      { officeName: 'Smith & Co', inviterName: 'Omar', link: `${APP}/accept`, days: 7 },
      APP,
    );
    expect(mail.html).toContain('<bdi>Smith &amp; Co</bdi>');
    expect(mail.subject).toBe('دعوة للانضمام إلى ⁨Smith & Co⁩ في NexLegTiq');
    expect(mail.text).toContain('⁨Omar⁩');
    expect(mail.html).toContain('خلال 7 أيام');
  });

  it('should escape values in HTML but not in the subject and plain text', () => {
    const mail = renderMail(
      'invite',
      'EN',
      { officeName: 'A & <B>', inviterName: 'Omar', link: `${APP}/accept`, days: 1 },
      APP,
    );
    expect(mail.subject).toBe('Invitation to join ⁨A & <B>⁩ on NexLegTiq');
    expect(mail.html).toContain('A &amp; &lt;B&gt;');
    expect(mail.html).not.toContain('<B>');
    expect(mail.text).toContain('A & <B>');
    expect(mail.text).toContain('expires in 1 day.');
  });

  it('should refuse variables that do not match the template', () => {
    expect(MAIL_TEMPLATE_SCHEMAS['verify-email'].safeParse({ name: 'Omar', days: 7 }).success).toBe(
      false,
    );
    expect(
      MAIL_TEMPLATE_SCHEMAS['password-reset'].safeParse({
        name: 'Omar',
        link: 'javascript:alert(1)',
        minutes: 60,
      }).success,
    ).toBe(false);
  });
});

describe('MailService', () => {
  it('should enqueue a send-email job with the template, locale and variables', async () => {
    const enqueue = jest.fn().mockResolvedValue({});
    const vars = { name: 'Omar', link: `${APP}/reset`, minutes: 60 };
    await new MailService({ enqueue } as unknown as QueueProducer).send(
      'a@b.test',
      'password-reset',
      'EN',
      vars,
    );
    expect(enqueue).toHaveBeenCalledWith('email', SEND_EMAIL_JOB, {
      to: 'a@b.test',
      template: 'password-reset',
      locale: 'EN',
      vars,
    });
  });
});

describe('MailTransport', () => {
  const mail = { subject: 'S', html: '<p>H</p>', text: 'T' };

  afterEach(() => jest.restoreAllMocks());

  it('should send through SMTP with the TLS settings and timeouts inside the queue timeout, reusing the connection', async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    const close = jest.fn();
    const create = jest
      .spyOn(nodemailer, 'createTransport')
      .mockReturnValue({ sendMail, close } as never);
    const transport = new MailTransport(
      config({ SMTP_HOST: 'smtp.test', SMTP_PORT: '1025', SMTP_REQUIRE_TLS: 'false' }),
    );

    await transport.send('a@b.test', mail);
    await transport.send('c@d.test', mail);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.test',
        port: 1025,
        requireTLS: false,
        connectionTimeout: 10_000,
        socketTimeout: 15_000,
      }),
    );
    expect(sendMail).toHaveBeenCalledWith({
      from: 'no-reply@nexlegtiq.test',
      to: 'a@b.test',
      subject: 'S',
      html: '<p>H</p>',
      text: 'T',
    });
    transport.onModuleDestroy();
    expect(close).toHaveBeenCalled();
  });

  it('should map an SMTP failure to EXT-001 without the provider message, which quotes the address', async () => {
    const rejected = Object.assign(new Error('550 5.1.1 <a@b.test>: Recipient address rejected'), {
      code: 'EENVELOPE',
      responseCode: 550,
    });
    jest
      .spyOn(nodemailer, 'createTransport')
      .mockReturnValue({ sendMail: jest.fn().mockRejectedValue(rejected) } as never);
    const error = await new MailTransport(config())
      .send('a@b.test', mail)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'EXT-001' });
    expect((error as Error).cause).toEqual({ name: 'Error', code: 'EENVELOPE', responseCode: 550 });
    expect(JSON.stringify((error as Error).cause)).not.toContain('a@b.test');
  });

  it('should send through the Resend API with the key and an idempotency key', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const signal = new AbortController().signal;
    await new MailTransport(
      config({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_key' }),
    ).send('a@b.test', mail, {
      signal,
      idempotencyKey: 'job-7',
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer re_test_key',
      'Idempotency-Key': 'job-7',
    });
    expect(init?.signal).toBe(signal);
    expect(JSON.parse(String(init?.body))).toEqual({
      from: 'no-reply@nexlegtiq.test',
      to: ['a@b.test'],
      subject: 'S',
      html: '<p>H</p>',
      text: 'T',
    });
  });

  it.each([
    [422, UnrecoverableError, undefined],
    [401, UnrecoverableError, undefined],
    [429, Error, 'EXT-001'],
    [503, Error, 'EXT-001'],
  ])('should treat a Resend %s as %p', async (status, type, code) => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"message":"a@b.test is invalid"}', { status }));
    const error = await new MailTransport(
      config({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_key' }),
    )
      .send('a@b.test', mail)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(type);
    if (code) expect(error).toMatchObject({ code });
    expect(String((error as Error).message)).not.toContain('a@b.test');
  });

  it('should treat a network failure as EXT-001', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'));
    const transport = new MailTransport(
      config({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_key' }),
    );
    await expect(transport.send('a@b.test', mail)).rejects.toMatchObject({ code: 'EXT-001' });
  });
});
