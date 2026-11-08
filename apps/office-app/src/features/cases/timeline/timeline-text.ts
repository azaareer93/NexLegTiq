import type { TimelineEvent } from '@nexlegtiq/shared-contracts';
import type { Formatters } from '@nexlegtiq/shared-ui';
import { isolate, isolateLtr } from '@nexlegtiq/shared-utils';
import type { TFunction } from 'i18next';

type Params = Record<string, string>;

/** What a sentence needs from one event: its payload as text, labels, names and dates. */
interface Reader {
  readonly text: (key: string) => string;
  /** A label of a stored enum value, or nothing for a value this build does not know (never the raw value, D-016). */
  readonly label: (enumName: string, key: string) => string;
  /** A colleague named by id in the payload, isolated (bidi controls inside are stripped, D-092). */
  readonly person: (key: string) => string;
  readonly client: (key: string) => string;
  /** User text from the payload (a document name, a task title), isolated. */
  readonly value: (key: string) => string;
  readonly date: () => string;
  readonly number: (key: string) => string;
}

/** The sentence key (under `timeline.event.`) and params of the types whose sentence needs more than the bare key. */
const SENTENCES: Readonly<Record<string, (r: Reader) => [string, Params]>> = {
  FILE_OPENED: (r) => ['FILE_OPENED', { fileNumber: isolateLtr(r.text('fileNumber')) }],
  FILE_REASSIGNED: (r) =>
    r.text('fromUserId')
      ? ['FILE_REASSIGNED.fromTo', { from: r.person('fromUserId'), to: r.person('toUserId') }]
      : ['FILE_REASSIGNED.to', { to: r.person('toUserId') }],
  SESSION_CREATED: (r) => [
    'SESSION_CREATED',
    { sessionType: r.label('sessionType', 'sessionType'), date: r.date() },
  ],
  SESSION_UPDATED: (r) => {
    const change = r.text('change');
    return [
      `SESSION_UPDATED.${change === 'CANCELLED' || change === 'OUTCOME' ? change : 'UPDATED'}`,
      {
        sessionType: r.label('sessionType', 'sessionType'),
        date: r.date(),
        outcome: r.label('sessionOutcome', 'outcome'),
      },
    ];
  },
  // A confidential document's name stays out of the timeline (D-126): its own sentences, not a placeholder.
  DOCUMENT_UPLOADED: (r) => {
    const confidential = r.text('name') ? '' : 'Confidential';
    const version = Number(r.text('versionNumber')) || 1;
    return version > 1
      ? [
          `DOCUMENT_UPLOADED.version${confidential}`,
          { name: r.value('name'), versionNumber: r.number('versionNumber') },
        ]
      : [`DOCUMENT_UPLOADED.first${confidential}`, { name: r.value('name') }];
  },
  DOCUMENT_SHARED: (r) =>
    r.text('name')
      ? ['DOCUMENT_SHARED.named', { name: r.value('name') }]
      : ['DOCUMENT_SHARED.confidential', {}],
  TASK_COMPLETED: (r) => ['TASK_COMPLETED', { title: r.value('title') }],
  PARTY_ADDED: (r) => [
    'PARTY_ADDED',
    { name: r.value('name'), partyType: r.label('partyType', 'partyType') },
  ],
  CLIENT_ADDED: (r) => ['CLIENT_ADDED', { name: r.client('clientId') }],
  CLIENT_REMOVED: (r) => ['CLIENT_REMOVED', { name: r.client('clientId') }],
  TEAM_MEMBER_ADDED: (r) => [
    'TEAM_MEMBER_ADDED',
    { name: r.person('userId'), role: r.label('fileTeamRole', 'role') },
  ],
  TEAM_MEMBER_REMOVED: (r) => ['TEAM_MEMBER_REMOVED', { name: r.person('userId') }],
};

/**
 * The sentence of one timeline event in the reader's language (D-150): `timeline.event.<TYPE>` with params made from the
 * payload — enum values as their labels, instants in the office's time and digits, people and clients by name from the
 * page, every user value isolated so it cannot reorder the sentence around it.
 */
export function eventSentence(
  t: TFunction,
  format: Pick<Formatters, 'dateTime' | 'number'>,
  event: Pick<TimelineEvent, 'eventType' | 'payload'>,
  names: Readonly<Record<string, string>>,
): string {
  const text = (key: string): string => {
    const value = event.payload[key];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  };
  const reader: Reader = {
    text,
    label: (enumName, key) =>
      text(key) ? t(`enums.${enumName}.${text(key)}` as never, { defaultValue: '' }) : '',
    person: (key) => isolate(names[text(key)] ?? t('timeline.unknownPerson')),
    client: (key) => isolate(names[text(key)] ?? t('timeline.unknownClient')),
    value: (key) => isolate(text(key)),
    date: () => (text('startsAt') ? isolate(format.dateTime(text('startsAt'))) : ''),
    number: (key) => format.number(text(key)),
  };
  const sentence = SENTENCES[event.eventType];
  const [key, params] = sentence ? sentence(reader) : [event.eventType, {}];
  return t(`timeline.event.${key}` as never, params);
}
