// First Strong Isolate / Pop Directional Isolate, as in templates.ts: user values keep their own direction.
const iso = (variable: string) => `⁨{{${variable}}}⁩`;

interface Copy {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** Client-portal invitation copy (D-158), apart from templates.ts to keep that file short. */
export const CLIENT_INVITE_COPY: Readonly<Record<'AR' | 'EN', Copy>> = {
  AR: {
    subject: `دعوة إلى بوابة الموكلين في ${iso('officeName')}`,
    html: `<p>مرحبًا،</p>
<p>دعاك <bdi>{{inviterName}}</bdi> من مكتب <bdi>{{officeName}}</bdi> إلى بوابة الموكلين لمتابعة ملفات <bdi>{{clientName}}</bdi> في <bdi dir="ltr">NexLegTiq</bdi>.</p>
<p>{{> button label="قبول الدعوة"}}</p>
{{> fallback}}
<p>تنتهي هذه الدعوة خلال {{period}}.</p>`,
    text: `مرحبًا،

دعاك ${iso('inviterName')} من مكتب ${iso('officeName')} إلى بوابة الموكلين لمتابعة ملفات ${iso('clientName')}:
{{link}}

تنتهي هذه الدعوة خلال {{period}}.`,
  },
  EN: {
    subject: `Invitation to the ${iso('officeName')} client portal`,
    html: `<p>Hello,</p>
<p><bdi>{{inviterName}}</bdi> of <bdi>{{officeName}}</bdi> has invited you to the client portal to follow the files of <bdi>{{clientName}}</bdi> on NexLegTiq.</p>
<p>{{> button label="Accept invitation"}}</p>
{{> fallback}}
<p>This invitation expires in {{period}}.</p>`,
    text: `Hello,

${iso('inviterName')} of ${iso('officeName')} has invited you to the client portal to follow the files of ${iso('clientName')}:
{{link}}

This invitation expires in {{period}}.`,
  },
};
