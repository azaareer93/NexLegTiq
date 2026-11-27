import { z } from 'zod';

// First Strong Isolate / Pop Directional Isolate, as in templates.ts: user values keep their own direction.
const iso = (variable: string) => `⁨{{${variable}}}⁩`;

/**
 * Variables of the three office-deletion emails (MVP-152, D-251), sent to every active office manager. `date` is the
 * purge date as the sender formatted it (the office's time zone); empty for a cancellation.
 */
export const OFFICE_DELETION_VARS = z.object({
  name: z.string().trim().min(1).max(200),
  officeName: z.string().trim().min(1).max(200),
  link: z.url({ protocol: /^https?$/ }),
  date: z.string().trim().max(100),
});

interface Copy {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}
type Copies = Readonly<Record<'AR' | 'EN', Copy>>;

const LOCALE = {
  AR: { hello: 'مرحبًا', comma: '،', button: 'فتح الإعدادات' },
  EN: { hello: 'Hello', comma: ',', button: 'Open Settings' },
} as const;

/** One locale's email: a greeting, the sentence of the event (NAME, DATE placeholders), a button to Settings. */
function one(locale: 'AR' | 'EN', subject: string, body: string): Copy {
  const { hello, comma, button } = LOCALE[locale];
  return {
    subject: subject.replace('NAME', iso('officeName')),
    html: `<p>${hello} <bdi>{{name}}</bdi>${comma}</p>
<p>${body.replaceAll('NAME', '<bdi>{{officeName}}</bdi>').replaceAll('DATE', '<bdi>{{date}}</bdi>')}</p>
<p>{{> button label="${button}"}}</p>
{{> fallback}}`,
    text: `${hello} ${iso('name')}${comma}

${body.replaceAll('NAME', iso('officeName')).replaceAll('DATE', iso('date'))}

{{link}}`,
  };
}

function copy(
  ar: { subject: string; body: string },
  en: { subject: string; body: string },
): Copies {
  return { AR: one('AR', ar.subject, ar.body), EN: one('EN', en.subject, en.body) };
}

const NOT_YOU = {
  ar: 'إن لم يطلب أحد في مكتبك ذلك، فألغِ الحذف من الإعدادات وغيّر كلمة المرور.',
  en: 'If nobody in your office asked for this, cancel the deletion in Settings and change your password.',
};

export const OFFICE_DELETION_COPY = {
  'office-deletion-requested': copy(
    {
      subject: 'طلب حذف NAME',
      body: `طُلب حذف NAME وكل بياناته. أصبح المكتب للقراءة فقط، وسيُحذف نهائيًا اعتبارًا من DATE. يبقى تصدير البيانات متاحًا حتى ذلك الحين، ويمكن لأي مدير مكتب إلغاء الحذف. ${NOT_YOU.ar}`,
    },
    {
      subject: 'Deletion of NAME requested',
      body: `Someone asked to delete NAME and all its data. The office is now read-only and will be deleted for good from DATE. The data export stays available until then, and any office manager can cancel the deletion. ${NOT_YOU.en}`,
    },
  ),
  'office-deletion-cancelled': copy(
    {
      subject: 'أُلغي حذف NAME',
      body: 'أُلغي حذف NAME. عاد المكتب إلى العمل كالمعتاد.',
    },
    {
      subject: 'Deletion of NAME cancelled',
      body: 'The deletion of NAME was cancelled. The office works as usual again.',
    },
  ),
  'office-deletion-rescheduled': copy(
    {
      subject: 'موعد جديد لحذف NAME',
      body: `بناءً على طلب مكتبك المكتوب، سيُحذف NAME نهائيًا اعتبارًا من DATE. ${NOT_YOU.ar}`,
    },
    {
      subject: 'New deletion date for NAME',
      body: `At your office's written request, NAME will now be deleted for good from DATE. ${NOT_YOU.en}`,
    },
  ),
} as const;

export const OFFICE_DELETION_TEMPLATES = {
  'office-deletion-requested': OFFICE_DELETION_VARS,
  'office-deletion-cancelled': OFFICE_DELETION_VARS,
  'office-deletion-rescheduled': OFFICE_DELETION_VARS,
} as const;
