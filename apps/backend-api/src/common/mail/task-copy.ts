import { z } from 'zod';

// First Strong Isolate / Pop Directional Isolate, as in templates.ts: user values keep their own direction.
const iso = (variable: string) => `⁨{{${variable}}}⁩`;
const text = (max: number) => z.string().trim().max(max);

const TaskLine = z.object({
  title: text(500).min(1),
  dueDate: text(100).min(1),
  /** OVERDUE | TODAY | SOON: which wording the line gets. */
  overdue: z.boolean(),
  today: z.boolean(),
});

/** Variables of the daily task email (MVP-79, D-177): the user's open tasks due soon, today or overdue, by file. */
export const TASK_DIGEST_VARS = z.object({
  name: z.string().trim().min(1).max(200),
  link: z.url({ protocol: /^https?$/ }),
  count: z.number().int().min(1).max(10_000),
  files: z
    .array(
      z.object({
        fileNumber: text(64),
        fileTitle: text(500),
        tasks: z.array(TaskLine).min(1).max(200),
      }),
    )
    .min(1)
    .max(200),
});

interface Copy {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

const list = (overdue: string, today: string, due: string) => `<ul>{{#each files}}
<li>{{#if fileNumber}}<bdi dir="ltr">{{fileNumber}}</bdi> — <bdi>{{fileTitle}}</bdi>{{else}}${due}{{/if}}<ul>{{#each tasks}}
<li><bdi>{{title}}</bdi> — {{#if overdue}}<strong>${overdue}</strong>{{else}}{{#if today}}<strong>${today}</strong>{{else}}${due}{{/if}}{{/if}} <bdi>{{dueDate}}</bdi></li>{{/each}}</ul></li>{{/each}}
</ul>`;
const plain = (overdue: string, today: string, due: string) => `{{#each files}}
{{#if fileNumber}}⁨{{fileNumber}}⁩ — ⁨{{fileTitle}}⁩{{else}}${due}{{/if}}{{#each tasks}}
- ⁨{{title}}⁩ — {{#if overdue}}${overdue}{{else}}{{#if today}}${today}{{else}}${due}{{/if}}{{/if}} ⁨{{dueDate}}⁩{{/each}}
{{/each}}`;

/** No buttons per task: one link to the user's tasks. Apart from templates.ts to keep that file short. */
export const TASK_DIGEST_COPY: Readonly<Record<'AR' | 'EN', Copy>> = {
  AR: {
    subject: `مهامك اليوم: ${iso('count')} مهمة تحتاج إلى متابعة`,
    html: `<p>مرحبًا <bdi>{{name}}</bdi>،</p>
<p>هذه مهامك المفتوحة المستحقة قريبًا أو اليوم أو المتأخرة:</p>
${list('متأخرة منذ', 'مستحقة اليوم', 'مستحقة في')}
<p>{{> button label="عرض مهامي"}}</p>
{{> fallback}}`,
    text: `مرحبًا ${iso('name')}،

هذه مهامك المفتوحة المستحقة قريبًا أو اليوم أو المتأخرة:
${plain('متأخرة منذ', 'مستحقة اليوم', 'مستحقة في')}
عرض مهامي:
{{link}}`,
  },
  EN: {
    subject: `Your tasks today: ${iso('count')} need attention`,
    html: `<p>Hello <bdi>{{name}}</bdi>,</p>
<p>These open tasks of yours are due soon, due today or overdue:</p>
${list('Overdue since', 'Due today', 'Due on')}
<p>{{> button label="View my tasks"}}</p>
{{> fallback}}`,
    text: `Hello ${iso('name')},

These open tasks of yours are due soon, due today or overdue:
${plain('Overdue since', 'Due today', 'Due on')}
View my tasks:
{{link}}`,
  },
};
