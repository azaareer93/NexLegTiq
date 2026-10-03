import nodemailer from 'nodemailer';

import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';
import type { QueueProducer } from '../queue/queue-producer';
import { MailService, SEND_EMAIL_JOB } from './mail.service';
import { MailTransport } from './mail-transport';
import { MAIL_TEMPLATE_NAMES, renderMail } from './templates';

const APP = 'https://app.example.test';
const config = (env: Record<string, string> = {}) => new AppConfig(parseEnv(testEnv({ NODE_ENV: 'development', ...env })));

describe('renderMail', () => {
  it.each(MAIL_TEMPLATE_NAMES)('should render %s in Arabic (rtl) and English (ltr) with the legal links', (template) => {
    const vars = { name: 'عمر', officeName: 'مكتب', inviterName: 'سارة', link: `${APP}/x?token=abc`, days: 7, minutes: 60 };
    const ar = renderMail(template, 'AR', vars as never, APP);
    const en = renderMail(template, 'EN', vars as never, APP);

    expect(ar.html).toContain('<html lang="ar" dir="rtl">');
    expect(ar.html).toContain('text-align:right');
    expect(ar.html).toContain('Noto Naskh Arabic');
    expect(en.html).toContain('<html lang="en" dir="ltr">');
    expect(en.html).toContain('text-align:left');
    for (const mail of [ar, en]) {
      expect(mail.subject.length).toBeGreaterThan(5);
      // Handlebars encodes '=' in attribute values; browsers decode it.
      expect(mail.html).toContain(`href="${APP}/x?token&#x3D;abc"`);
      expect(mail.html).toContain(`${APP}/legal/terms`);
      expect(mail.html).toContain(`${APP}/legal/privacy`);
      expect(mail.text).toContain(`${APP}/x?token=abc`);
    }
  });

  it('should escape values in HTML but not in the subject and plain text', () => {
    const mail = renderMail('invite', 'EN', { officeName: 'A & <B>', inviterName: 'Omar', link: `${APP}/accept`, days: 7 }, APP);
    expect(mail.subject).toBe('Invitation to join A & <B> on NexLegTiq');
    expect(mail.html).toContain('A &amp; &lt;B&gt;');
    expect(mail.html).not.toContain('<B>');
    expect(mail.text).toContain('A & <B>');
  });

  it('should refuse to render with a missing variable', () => {
    expect(() => renderMail('verify-email', 'EN', { name: 'Omar', days: 7 } as never, APP)).toThrow();
  });
});

describe('MailService', () => {
  it('should enqueue a send-email job with the template, locale and variables', async () => {
    const enqueue = jest.fn().mockResolvedValue({});
    const vars = { name: 'Omar', link: `${APP}/reset`, minutes: 60 };
    await new MailService({ enqueue } as unknown as QueueProducer).send('a@b.test', 'password-reset', 'EN', vars);
    expect(enqueue).toHaveBeenCalledWith('email', SEND_EMAIL_JOB, { to: 'a@b.test', template: 'password-reset', locale: 'EN', vars });
  });
});

describe('MailTransport', () => {
  const mail = { subject: 'S', html: '<p>H</p>', text: 'T' };

  afterEach(() => jest.restoreAllMocks());

  it('should send through SMTP with the configured TLS settings and reuse the connection', async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    const close = jest.fn();
    const create = jest.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail, close } as never);
    const transport = new MailTransport(config({ SMTP_HOST: 'smtp.test', SMTP_PORT: '1025', SMTP_REQUIRE_TLS: 'false' }));

    await transport.send('a@b.test', mail);
    await transport.send('c@d.test', mail);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.test', port: 1025, requireTLS: false }));
    expect(sendMail).toHaveBeenCalledWith({ from: 'no-reply@nexlegtiq.test', to: 'a@b.test', subject: 'S', html: '<p>H</p>', text: 'T' });
    transport.onModuleDestroy();
    expect(close).toHaveBeenCalled();
  });

  it('should map an SMTP failure to EXT-001 so the job is retried', async () => {
    jest.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) } as never);
    await expect(new MailTransport(config()).send('a@b.test', mail)).rejects.toMatchObject({ code: 'EXT-001' });
  });

  it('should send through the Resend API with the key, and map a refusal to EXT-001', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const transport = new MailTransport(config({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_key' }));
    await transport.send('a@b.test', mail);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer re_test_key' });
    expect(JSON.parse(String(init?.body))).toEqual({ from: 'no-reply@nexlegtiq.test', to: ['a@b.test'], subject: 'S', html: '<p>H</p>', text: 'T' });

    fetchMock.mockResolvedValueOnce(new Response('{"message":"a@b.test is invalid"}', { status: 422 }));
    const refused = await transport.send('a@b.test', mail).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'EXT-001', message: 'Email provider answered 422' });
  });
});
