import Handlebars from 'handlebars';
import { z } from 'zod';

/** Email locales: the user's `uiLanguage` (D-016). Bilingual offices write to each user in that user's language. */
export type MailLocale = 'AR' | 'EN';

const name = z.string().trim().min(1).max(200);
const link = z.url({ protocol: /^https?$/ });
const count = z.number().int().min(1).max(10_000);

/** Variables of each template, validated in the worker before rendering (D-085). Links are built by the sender. */
export const MAIL_TEMPLATE_SCHEMAS = {
  'verify-email': z.object({ name, link, days: count }),
  invite: z.object({ officeName: name, inviterName: name, link, days: count }),
  'password-reset': z.object({ name, link, minutes: count }),
} as const;
export type MailTemplateName = keyof typeof MAIL_TEMPLATE_SCHEMAS;
export type MailTemplates = { [K in MailTemplateName]: z.infer<(typeof MAIL_TEMPLATE_SCHEMAS)[K]> };
export const MAIL_TEMPLATE_NAMES = Object.keys(MAIL_TEMPLATE_SCHEMAS) as MailTemplateName[];

/**
 * "7 days" / "٧ أيام" with Arabic number agreement (Intl plural categories): يوم واحد، يومين، 3–10 أيام، 11–99 يومًا،
 * 100+ يوم — and the same for minutes. Digits stay Western (frontend.md).
 */
export function duration(value: number, unit: 'day' | 'minute', locale: MailLocale): string {
  if (locale === 'EN')
    return `${value} ${unit}${new Intl.PluralRules('en').select(value) === 'one' ? '' : 's'}`;
  const forms =
    unit === 'day'
      ? { one: 'يوم واحد', two: 'يومين', few: 'أيام', many: 'يومًا', other: 'يوم' }
      : { one: 'دقيقة واحدة', two: 'دقيقتين', few: 'دقائق', many: 'دقيقة', other: 'دقيقة' };
  const category = new Intl.PluralRules('ar').select(value);
  if (category === 'one' || category === 'two') return forms[category];
  return `${value} ${category === 'few' || category === 'zero' ? forms.few : category === 'many' ? forms.many : forms.other}`;
}

interface Copy {
  readonly subject: string;
  /** Inner HTML of the message; Handlebars escapes every {{value}}. User values sit in <bdi> so mixed scripts keep order. */
  readonly html: string;
  readonly text: string;
}

// First Strong Isolate / Pop Directional Isolate: <bdi> for subjects and plain text, which cannot carry HTML.
const FSI = '⁨';
const PDI = '⁩';
const iso = (variable: string) => `${FSI}{{${variable}}}${PDI}`;

/**
 * Copy per template and locale (MVP-35). Kept in code rather than files: no asset copying in the bundle, and the schemas
 * above stay next to the text that uses them. Arabic is MSA; terms follow glossary.md (مدير المكتب, المكتب).
 * `{{period}}` is the rendered duration ("7 أيام", "60 minutes").
 */
const COPY: Readonly<Record<MailTemplateName, Readonly<Record<MailLocale, Copy>>>> = {
  'verify-email': {
    AR: {
      subject: 'تأكيد بريدك الإلكتروني في NexLegTiq',
      html: `<p>مرحبًا <bdi>{{name}}</bdi>،</p>
<p>شكرًا لتسجيل مكتبك في <bdi dir="ltr">NexLegTiq</bdi>. أكّد بريدك الإلكتروني للاستمرار في استخدام حسابك.</p>
<p>{{> button label="تأكيد البريد الإلكتروني"}}</p>
{{> fallback}}
<p>ينتهي هذا الرابط خلال {{period}}. إذا لم تُنشئ هذا الحساب فتجاهل هذه الرسالة.</p>`,
      text: `مرحبًا ${iso('name')}،

شكرًا لتسجيل مكتبك في NexLegTiq. أكّد بريدك الإلكتروني للاستمرار في استخدام حسابك:
{{link}}

ينتهي هذا الرابط خلال {{period}}. إذا لم تُنشئ هذا الحساب فتجاهل هذه الرسالة.`,
    },
    EN: {
      subject: 'Confirm your email for NexLegTiq',
      html: `<p>Hello <bdi>{{name}}</bdi>,</p>
<p>Thank you for signing up your office on NexLegTiq. Please confirm your email address to keep using your account.</p>
<p>{{> button label="Confirm email"}}</p>
{{> fallback}}
<p>This link expires in {{period}}. If you did not create this account, you can ignore this email.</p>`,
      text: `Hello ${iso('name')},

Thank you for signing up your office on NexLegTiq. Please confirm your email address to keep using your account:
{{link}}

This link expires in {{period}}. If you did not create this account, you can ignore this email.`,
    },
  },
  invite: {
    AR: {
      subject: `دعوة للانضمام إلى ${iso('officeName')} في NexLegTiq`,
      html: `<p>مرحبًا،</p>
<p>دعاك <bdi>{{inviterName}}</bdi> للانضمام إلى مكتب <bdi>{{officeName}}</bdi> في <bdi dir="ltr">NexLegTiq</bdi>.</p>
<p>{{> button label="قبول الدعوة"}}</p>
{{> fallback}}
<p>تنتهي هذه الدعوة خلال {{period}}.</p>`,
      text: `مرحبًا،

دعاك ${iso('inviterName')} للانضمام إلى مكتب ${iso('officeName')} في NexLegTiq:
{{link}}

تنتهي هذه الدعوة خلال {{period}}.`,
    },
    EN: {
      subject: `Invitation to join ${iso('officeName')} on NexLegTiq`,
      html: `<p>Hello,</p>
<p><bdi>{{inviterName}}</bdi> has invited you to join <bdi>{{officeName}}</bdi> on NexLegTiq.</p>
<p>{{> button label="Accept invitation"}}</p>
{{> fallback}}
<p>This invitation expires in {{period}}.</p>`,
      text: `Hello,

${iso('inviterName')} has invited you to join ${iso('officeName')} on NexLegTiq:
{{link}}

This invitation expires in {{period}}.`,
    },
  },
  'password-reset': {
    AR: {
      subject: 'إعادة تعيين كلمة المرور في NexLegTiq',
      html: `<p>مرحبًا <bdi>{{name}}</bdi>،</p>
<p>تلقّينا طلبًا لإعادة تعيين كلمة المرور لحسابك.</p>
<p>{{> button label="إعادة تعيين كلمة المرور"}}</p>
{{> fallback}}
<p>ينتهي هذا الرابط خلال {{period}}. إذا لم تطلب ذلك فتجاهل هذه الرسالة؛ ولن تتغيّر كلمة المرور.</p>`,
      text: `مرحبًا ${iso('name')}،

تلقّينا طلبًا لإعادة تعيين كلمة المرور لحسابك في NexLegTiq:
{{link}}

ينتهي هذا الرابط خلال {{period}}. إذا لم تطلب ذلك فتجاهل هذه الرسالة؛ ولن تتغيّر كلمة المرور.`,
    },
    EN: {
      subject: 'Reset your NexLegTiq password',
      html: `<p>Hello <bdi>{{name}}</bdi>,</p>
<p>We received a request to reset the password of your account.</p>
<p>{{> button label="Reset password"}}</p>
{{> fallback}}
<p>This link expires in {{period}}. If you did not ask for this, ignore this email; your password stays the same.</p>`,
      text: `Hello ${iso('name')},

We received a request to reset the password of your NexLegTiq account:
{{link}}

This link expires in {{period}}. If you did not ask for this, ignore this email; your password stays the same.`,
    },
  },
};

const PERIOD_OF: Readonly<
  Record<MailTemplateName, { readonly key: 'days' | 'minutes'; readonly unit: 'day' | 'minute' }>
> = {
  'verify-email': { key: 'days', unit: 'day' },
  invite: { key: 'days', unit: 'day' },
  'password-reset': { key: 'minutes', unit: 'minute' },
};

const FOOTER: Readonly<
  Record<
    MailLocale,
    { noteHtml: string; noteText: string; terms: string; privacy: string; fallback: string }
  >
> = {
  AR: {
    noteHtml: 'أُرسلت هذه الرسالة من <bdi dir="ltr">NexLegTiq</bdi>.',
    noteText: 'أُرسلت هذه الرسالة من NexLegTiq',
    terms: 'شروط الخدمة',
    privacy: 'سياسة الخصوصية',
    fallback: 'إذا لم يعمل الزر، فانسخ الرابط التالي والصقه في المتصفح:',
  },
  EN: {
    noteHtml: 'This email was sent by NexLegTiq.',
    noteText: 'This email was sent by NexLegTiq.',
    terms: 'Terms of Service',
    privacy: 'Privacy Policy',
    fallback: 'If the button does not work, copy this link into your browser:',
  },
};

/**
 * Fonts installed on recipients' devices (email clients do not load web fonts): Arabic-capable Tahoma/Segoe UI first for
 * Arabic, the English UI stack for English (frontend.md: Noto Naskh Arabic / Inter in the app, kept as late fallbacks).
 */
const FONT_STACK: Readonly<Record<MailLocale, string>> = {
  AR: "Tahoma, 'Segoe UI', Arial, 'Noto Naskh Arabic', sans-serif",
  EN: "'Segoe UI', Helvetica, Arial, Inter, sans-serif",
};

/**
 * Base layout: `lang` and `dir` on <html> and on the content table (some clients drop <html> attributes), alignment
 * from the direction (email clients ignore logical CSS), brand header and a footer with the legal links. Inline styles only.
 * The brand is text until the logo is hosted.
 */
const LAYOUT = `<!doctype html>
<html lang="{{lang}}" dir="{{dir}}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{{subject}}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" lang="{{lang}}" dir="{{dir}}" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;text-align:{{align}};font-family:{{font}};">
<tr><td style="padding:24px 32px 8px;font-size:22px;font-weight:bold;color:#1f3a5f;"><bdi dir="ltr">NexLegTiq</bdi></td></tr>
<tr><td style="padding:8px 32px 24px;font-size:16px;line-height:1.8;color:#1f2933;">{{{body}}}</td></tr>
<tr><td style="padding:16px 32px 24px;font-size:12px;line-height:1.6;color:#6b7280;border-top:1px solid #e5e7eb;">
{{{footer.noteHtml}}}<br><a href="{{termsUrl}}" style="color:#6b7280;">{{footer.terms}}</a> · <a href="{{privacyUrl}}" style="color:#6b7280;">{{footer.privacy}}</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

const BUTTON = `<a href="{{link}}" style="display:inline-block;padding:12px 24px;background:#1f3a5f;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold;">{{label}}</a>`;
/** The link as text under the button: some clients block buttons. Kept left-to-right so the query string stays in order. */
const FALLBACK = `<p style="font-size:13px;color:#6b7280;">{{fallbackLabel}}<br><bdi dir="ltr" style="word-break:break-all;">{{link}}</bdi></p>`;

/** An isolated Handlebars instance: no global helpers or partials from elsewhere can change what emails render. */
const hbs = Handlebars.create();
hbs.registerPartial('button', BUTTON);
hbs.registerPartial('fallback', FALLBACK);
const compile = (source: string) => hbs.compile(source, { strict: true });
// Subjects and plain-text bodies are not HTML: escaping would turn an office named "A & B" into "A &amp; B".
const compilePlain = (source: string) => hbs.compile(source, { strict: true, noEscape: true });
const layout = compile(LAYOUT);
type Compiled = {
  subject: HandlebarsTemplateDelegate;
  html: HandlebarsTemplateDelegate;
  text: HandlebarsTemplateDelegate;
};
const compiled = Object.fromEntries(
  MAIL_TEMPLATE_NAMES.map((template) => [
    template,
    Object.fromEntries(
      (['AR', 'EN'] as const).map((locale) => {
        const copy = COPY[template][locale];
        return [
          locale,
          {
            subject: compilePlain(copy.subject),
            html: compile(copy.html),
            text: compilePlain(copy.text),
          },
        ];
      }),
    ),
  ]),
) as Record<MailTemplateName, Record<MailLocale, Compiled>>;

export interface RenderedMail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** Renders a template in a locale inside the base layout. `officeAppUrl` has no trailing slash. */
export function renderMail<T extends MailTemplateName>(
  template: T,
  locale: MailLocale,
  vars: MailTemplates[T],
  officeAppUrl: string,
): RenderedMail {
  const parts = compiled[template][locale];
  const period = PERIOD_OF[template];
  const context = {
    ...vars,
    period: duration(Number((vars as Record<string, unknown>)[period.key]), period.unit, locale),
    fallbackLabel: FOOTER[locale].fallback,
  };
  const subject = parts.subject(context);
  const dir = locale === 'AR' ? 'rtl' : 'ltr';
  const html = layout({
    lang: locale === 'AR' ? 'ar' : 'en',
    dir,
    align: dir === 'rtl' ? 'right' : 'left',
    font: FONT_STACK[locale],
    subject,
    body: parts.html(context),
    footer: FOOTER[locale],
    termsUrl: `${officeAppUrl}/legal/terms`,
    privacyUrl: `${officeAppUrl}/legal/privacy`,
  });
  return { subject, html, text: `${parts.text(context)}\n\n${FOOTER[locale].noteText}` };
}
