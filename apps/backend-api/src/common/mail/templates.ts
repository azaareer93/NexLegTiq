import Handlebars from 'handlebars';

/** Email locales: the user's `uiLanguage` (D-016). Bilingual offices write to each user in that user's language. */
export type MailLocale = 'AR' | 'EN';

/** Templates and the variables each one needs. Links are built by the sender, never by the template. */
export interface MailTemplates {
  'verify-email': { name: string; link: string; days: number };
  invite: { officeName: string; inviterName: string; link: string; days: number };
  'password-reset': { name: string; link: string; minutes: number };
}
export type MailTemplateName = keyof MailTemplates;
export const MAIL_TEMPLATE_NAMES = ['verify-email', 'invite', 'password-reset'] as const satisfies readonly MailTemplateName[];

interface Copy {
  readonly subject: string;
  /** Inner HTML of the message; Handlebars escapes every {{value}}. */
  readonly html: string;
  readonly text: string;
}

/**
 * Copy per template and locale (MVP-35). Kept in code rather than files: no asset copying in the bundle, and the types
 * above stay next to the text that uses them. Arabic is MSA; terms follow glossary.md (مدير المكتب, المكتب).
 */
const COPY: Readonly<Record<MailTemplateName, Readonly<Record<MailLocale, Copy>>>> = {
  'verify-email': {
    AR: {
      subject: 'أكّد بريدك الإلكتروني في NexLegTiq',
      html: `<p>مرحبًا {{name}}،</p>
<p>شكرًا لتسجيل مكتبك في NexLegTiq. أكّد بريدك الإلكتروني للاستمرار في استخدام حسابك.</p>
<p>{{> button label="تأكيد البريد الإلكتروني"}}</p>
<p>ينتهي هذا الرابط خلال {{days}} أيام. إذا لم تُنشئ هذا الحساب فتجاهل هذه الرسالة.</p>`,
      text: `مرحبًا {{name}}،

أكّد بريدك الإلكتروني للاستمرار في استخدام حسابك في NexLegTiq:
{{link}}

ينتهي هذا الرابط خلال {{days}} أيام. إذا لم تُنشئ هذا الحساب فتجاهل هذه الرسالة.`,
    },
    EN: {
      subject: 'Confirm your email for NexLegTiq',
      html: `<p>Hello {{name}},</p>
<p>Thank you for signing up your office on NexLegTiq. Please confirm your email address to keep using your account.</p>
<p>{{> button label="Confirm email"}}</p>
<p>This link expires in {{days}} days. If you did not create this account, you can ignore this email.</p>`,
      text: `Hello {{name}},

Please confirm your email address to keep using your NexLegTiq account:
{{link}}

This link expires in {{days}} days. If you did not create this account, you can ignore this email.`,
    },
  },
  invite: {
    AR: {
      subject: 'دعوة للانضمام إلى {{officeName}} في NexLegTiq',
      html: `<p>مرحبًا،</p>
<p>دعاك {{inviterName}} للانضمام إلى مكتب {{officeName}} في NexLegTiq.</p>
<p>{{> button label="قبول الدعوة"}}</p>
<p>تنتهي هذه الدعوة خلال {{days}} أيام.</p>`,
      text: `مرحبًا،

دعاك {{inviterName}} للانضمام إلى مكتب {{officeName}} في NexLegTiq:
{{link}}

تنتهي هذه الدعوة خلال {{days}} أيام.`,
    },
    EN: {
      subject: 'Invitation to join {{officeName}} on NexLegTiq',
      html: `<p>Hello,</p>
<p>{{inviterName}} has invited you to join {{officeName}} on NexLegTiq.</p>
<p>{{> button label="Accept invitation"}}</p>
<p>This invitation expires in {{days}} days.</p>`,
      text: `Hello,

{{inviterName}} has invited you to join {{officeName}} on NexLegTiq:
{{link}}

This invitation expires in {{days}} days.`,
    },
  },
  'password-reset': {
    AR: {
      subject: 'إعادة تعيين كلمة المرور في NexLegTiq',
      html: `<p>مرحبًا {{name}}،</p>
<p>تلقّينا طلبًا لإعادة تعيين كلمة المرور لحسابك.</p>
<p>{{> button label="إعادة تعيين كلمة المرور"}}</p>
<p>ينتهي هذا الرابط خلال {{minutes}} دقيقة. إذا لم تطلب ذلك فتجاهل هذه الرسالة، ولن تتغيّر كلمة المرور.</p>`,
      text: `مرحبًا {{name}}،

تلقّينا طلبًا لإعادة تعيين كلمة المرور لحسابك في NexLegTiq:
{{link}}

ينتهي هذا الرابط خلال {{minutes}} دقيقة. إذا لم تطلب ذلك فتجاهل هذه الرسالة.`,
    },
    EN: {
      subject: 'Reset your NexLegTiq password',
      html: `<p>Hello {{name}},</p>
<p>We received a request to reset the password of your account.</p>
<p>{{> button label="Reset password"}}</p>
<p>This link expires in {{minutes}} minutes. If you did not ask for this, ignore this email and your password stays the same.</p>`,
      text: `Hello {{name}},

We received a request to reset your NexLegTiq password:
{{link}}

This link expires in {{minutes}} minutes. If you did not ask for this, ignore this email.`,
    },
  },
};

const FOOTER: Readonly<Record<MailLocale, { note: string; terms: string; privacy: string }>> = {
  AR: { note: 'أُرسلت هذه الرسالة من NexLegTiq.', terms: 'شروط الخدمة', privacy: 'سياسة الخصوصية' },
  EN: { note: 'This email was sent by NexLegTiq.', terms: 'Terms of Service', privacy: 'Privacy Policy' },
};

/** Arabic-first stack (Arabic Localization Guide): clients without web fonts fall back to Tahoma/Arial, which cover Arabic. */
const FONT_STACK = "'Noto Naskh Arabic', 'Noto Sans Arabic', Tahoma, Arial, sans-serif";

/**
 * Base layout: `lang` and `dir` on <html>, alignment from the direction (email clients ignore logical CSS), brand header
 * and a footer with the legal links. Inline styles only — most clients drop <style>.
 */
const LAYOUT = `<!doctype html>
<html lang="{{lang}}" dir="{{dir}}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{{subject}}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" dir="{{dir}}" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;text-align:{{align}};font-family:${FONT_STACK};">
<tr><td style="padding:24px 32px 8px;font-size:22px;font-weight:bold;color:#1f3a5f;">NexLegTiq</td></tr>
<tr><td style="padding:8px 32px 24px;font-size:16px;line-height:1.8;color:#1f2933;">{{{body}}}</td></tr>
<tr><td style="padding:16px 32px 24px;font-size:12px;line-height:1.6;color:#6b7280;border-top:1px solid #e5e7eb;">
{{footer.note}}<br><a href="{{termsUrl}}" style="color:#6b7280;">{{footer.terms}}</a> · <a href="{{privacyUrl}}" style="color:#6b7280;">{{footer.privacy}}</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

const BUTTON = `<a href="{{link}}" style="display:inline-block;padding:12px 24px;background:#1f3a5f;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold;">{{label}}</a>`;

/** An isolated Handlebars instance: no global helpers or partials from elsewhere can change what emails render. */
const hbs = Handlebars.create();
hbs.registerPartial('button', BUTTON);
const compile = (source: string) => hbs.compile(source, { strict: true });
// Subjects and plain-text bodies are not HTML: escaping would turn an office named "A & B" into "A &amp; B".
const compilePlain = (source: string) => hbs.compile(source, { strict: true, noEscape: true });
const layout = compile(LAYOUT);
const compiled = Object.fromEntries(
  MAIL_TEMPLATE_NAMES.map((name) => [
    name,
    Object.fromEntries(
      (['AR', 'EN'] as const).map((locale) => {
        const copy = COPY[name][locale];
        return [locale, { subject: compilePlain(copy.subject), html: compile(copy.html), text: compilePlain(copy.text) }];
      }),
    ),
  ]),
) as Record<MailTemplateName, Record<MailLocale, { subject: HandlebarsTemplateDelegate; html: HandlebarsTemplateDelegate; text: HandlebarsTemplateDelegate }>>;

export interface RenderedMail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** Renders a template in a locale inside the base layout. `officeAppUrl` has no trailing slash. */
export function renderMail<T extends MailTemplateName>(template: T, locale: MailLocale, vars: MailTemplates[T], officeAppUrl: string): RenderedMail {
  const parts = compiled[template][locale];
  const subject = parts.subject(vars);
  const dir = locale === 'AR' ? 'rtl' : 'ltr';
  const html = layout({
    lang: locale === 'AR' ? 'ar' : 'en',
    dir,
    align: dir === 'rtl' ? 'right' : 'left',
    subject,
    body: parts.html(vars),
    footer: FOOTER[locale],
    termsUrl: `${officeAppUrl}/legal/terms`,
    privacyUrl: `${officeAppUrl}/legal/privacy`,
  });
  return { subject, html, text: `${parts.text(vars)}\n\n${FOOTER[locale].note}` };
}
