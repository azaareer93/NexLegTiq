import type { TimelineEvent } from '@nexlegtiq/shared-contracts';
import type { TimelineEventType } from '@nexlegtiq/shared-types';
import type { Formatters } from '@nexlegtiq/shared-ui';
import type { TFunction } from 'i18next';

type Params = Record<string, string | number>;

/** What a sentence needs from one event: its payload as text, labels, names and dates. */
interface Reader {
  readonly text: (key: string) => string;
  /** A label of a stored enum value, or nothing for a value this build does not know (never the raw value, D-016). */
  readonly label: (enumName: string, key: string) => string;
  /** The name of a colleague or client the payload names by id. */
  readonly person: (key: string) => string;
  readonly date: () => string;
  /** A confidential document's name stays out of the timeline (D-126). */
  readonly documentName: () => string;
}

/** The sentence key and params of the types whose sentence needs more than the bare key. */
const SENTENCES: Partial<Record<TimelineEventType, (r: Reader) => [string, Params]>> = {
  FILE_OPENED: (r) => ['FILE_OPENED', { fileNumber: r.text('fileNumber') }],
  FILE_REASSIGNED: (r) => [
    'FILE_REASSIGNED',
    { from: r.person('fromUserId'), to: r.person('toUserId') },
  ],
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
  DOCUMENT_UPLOADED: (r) => {
    const versionNumber = Number(r.text('versionNumber')) || 1;
    return versionNumber > 1
      ? ['DOCUMENT_UPLOADED.version', { name: r.documentName(), versionNumber }]
      : ['DOCUMENT_UPLOADED.first', { name: r.documentName() }];
  },
  DOCUMENT_SHARED: (r) => ['DOCUMENT_SHARED', { name: r.documentName() }],
  TASK_COMPLETED: (r) => ['TASK_COMPLETED', { title: r.text('title') }],
  PARTY_ADDED: (r) => [
    'PARTY_ADDED',
    { name: r.text('name'), partyType: r.label('partyType', 'partyType') },
  ],
  CLIENT_ADDED: (r) => ['CLIENT_ADDED', { name: r.person('clientId') }],
  CLIENT_REMOVED: (r) => ['CLIENT_REMOVED', { name: r.person('clientId') }],
  TEAM_MEMBER_ADDED: (r) => [
    'TEAM_MEMBER_ADDED',
    { name: r.person('userId'), role: r.label('fileTeamRole', 'role') },
  ],
  TEAM_MEMBER_REMOVED: (r) => ['TEAM_MEMBER_REMOVED', { name: r.person('userId') }],
};

/**
 * The sentence of one timeline event in the reader's language (D-150): `timeline.event.<TYPE>` with params made from the
 * payload — enum values as their labels, instants in the office's time, people and clients by name from the page.
 */
export function eventSentence(
  t: TFunction,
  format: Pick<Formatters, 'dateTime'>,
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
    person: (key) => names[text(key)] ?? t('timeline.someone'),
    date: () => (text('startsAt') ? format.dateTime(text('startsAt')) : ''),
    documentName: () => text('name') || t('timeline.confidentialDocument'),
  };
  const sentence = SENTENCES[event.eventType];
  const [key, params] = sentence ? sentence(reader) : [event.eventType, {}];
  return t(`timeline.event.${key}` as never, params);
}
