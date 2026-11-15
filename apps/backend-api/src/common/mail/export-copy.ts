import { z } from 'zod';

// First Strong Isolate / Pop Directional Isolate, as in templates.ts: user values keep their own direction.
const iso = (variable: string) => `⁨{{${variable}}}⁩`;

/** Variables of the "your export is ready" email (MVP-106, D-184): a link to the app, never to the file itself. */
export const EXPORT_READY_VARS = z.object({
  name: z.string().trim().min(1).max(200),
  officeName: z.string().trim().min(1).max(200),
  link: z.url({ protocol: /^https?$/ }),
  days: z.number().int().min(1).max(30),
});

interface Copy {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** The download needs the user signed in: the link opens Settings, which asks for a short download link (D-013). */
export const EXPORT_READY_COPY: Readonly<Record<'AR' | 'EN', Copy>> = {
  AR: {
    subject: `تصدير بيانات ${iso('officeName')} جاهز`,
    html: `<p>مرحبًا <bdi>{{name}}</bdi>،</p>
<p>أصبح تصدير بيانات <bdi>{{officeName}}</bdi> جاهزًا للتنزيل من الإعدادات. يبقى متاحًا {{days}} أيام.</p>
<p>{{> button label="فتح الإعدادات"}}</p>
{{> fallback}}`,
    text: `مرحبًا ${iso('name')}،

أصبح تصدير بيانات ${iso('officeName')} جاهزًا للتنزيل من الإعدادات. يبقى متاحًا ${iso('days')} أيام.

{{link}}`,
  },
  EN: {
    subject: `The data export of ${iso('officeName')} is ready`,
    html: `<p>Hello <bdi>{{name}}</bdi>,</p>
<p>The data export of <bdi>{{officeName}}</bdi> is ready to download from Settings. It stays available for {{days}} days.</p>
<p>{{> button label="Open Settings"}}</p>
{{> fallback}}`,
    text: `Hello ${iso('name')},

The data export of ${iso('officeName')} is ready to download from Settings. It stays available for {{days}} days.

{{link}}`,
  },
};
