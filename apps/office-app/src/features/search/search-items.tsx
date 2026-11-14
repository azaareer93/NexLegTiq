import {
  CheckSquareOutlined,
  FileTextOutlined,
  FolderOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { SearchResults, SearchType, SnippetPart } from '@nexlegtiq/shared-contracts';
import { Bdi, Ltr } from '@nexlegtiq/shared-ui';
import { Typography, theme } from 'antd';
import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';

/** One line of the result list: a link to open, or an action inside the overlay. */
export interface SearchItem {
  readonly key: string;
  readonly href?: string;
  readonly onPick?: () => void;
  readonly icon?: ReactNode;
  readonly content: ReactNode;
}

export interface SearchGroup {
  readonly key: string;
  readonly title: string;
  readonly items: readonly SearchItem[];
}

/** Parties are left out: they have no page to open (D-172). */
export const GROUP_ORDER = [
  'cases',
  'clients',
  'documents',
  'tasks',
] as const satisfies readonly SearchType[];
type ShownType = (typeof GROUP_ORDER)[number];

/** An action inside the result list: coloured like a link, but plain text — an option holds no nested control. */
export function ActionText({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const { token } = theme.useToken();
  return <span style={{ color: token.colorLink }}>{children}</span>;
}

const Secondary = ({ children }: { readonly children: ReactNode }) => (
  <Typography.Text type="secondary">{children}</Typography.Text>
);

const fileRef = (file: { readonly fileNumber: string; readonly title: string }) => (
  <>
    <Ltr>{file.fileNumber}</Ltr> <Bdi>{file.title}</Bdi>
  </>
);

/** The query's words come back marked; rendered as text, never HTML (D-167). */
const Snippet = ({ parts }: { readonly parts: readonly SnippetPart[] }) => (
  <Typography.Text
    type="secondary"
    dir="auto"
    style={{ display: 'block', unicodeBidi: 'plaintext' }}
  >
    {parts.map((part, index) =>
      part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
    )}
  </Typography.Text>
);

const ITEMS: {
  readonly [K in ShownType]: (results: SearchResults, t: TFunction) => readonly SearchItem[];
} = {
  cases: (results, t) =>
    results.cases.items.map((file) => ({
      key: `cases-${file.id}`,
      href: `/cases/${file.id}`,
      icon: <FolderOutlined />,
      content: (
        <>
          {fileRef(file)} <Secondary>{t(`enums.fileStatus.${file.status}`)}</Secondary>
        </>
      ),
    })),
  clients: (results, t) =>
    results.clients.items.map((client) => ({
      key: `clients-${client.id}`,
      href: `/clients/${client.id}`,
      icon: <UserOutlined />,
      content: (
        <>
          <Bdi>{client.displayName}</Bdi>{' '}
          <Secondary>{t(`enums.clientType.${client.clientType}`)}</Secondary>
        </>
      ),
    })),
  documents: (results) =>
    results.documents.items.map((document) => ({
      key: `documents-${document.id}`,
      href: `/cases/${document.file.id}?tab=documents`,
      icon: <FileTextOutlined />,
      content: (
        <>
          <Bdi>{document.name}</Bdi> <Secondary>{fileRef(document.file)}</Secondary>
          {document.snippet.length > 0 ? <Snippet parts={document.snippet} /> : null}
        </>
      ),
    })),
  tasks: (results, t) =>
    results.tasks.items.map((task) => ({
      key: `tasks-${task.id}`,
      href: task.file ? `/cases/${task.file.id}?tab=tasks` : '/tasks',
      icon: <CheckSquareOutlined />,
      content: (
        <>
          <Bdi>{task.title}</Bdi>{' '}
          <Secondary>{task.file ? fileRef(task.file) : t('shell.search.personalTask')}</Secondary>
        </>
      ),
    })),
};

/** The groups that found something, in a fixed order, each ending with "see all" while the API has more. */
export function resultGroups(
  results: SearchResults,
  t: TFunction,
  onSeeAll: ((type: SearchType) => void) | null,
): SearchGroup[] {
  return GROUP_ORDER.flatMap((type) => {
    const items = ITEMS[type](results, t);
    if (items.length === 0) return [];
    const title = t(`shell.search.groups.${type}`);
    const more: SearchItem[] =
      onSeeAll && results[type].hasMore
        ? [
            {
              key: `more-${type}`,
              onPick: () => onSeeAll(type),
              content: <ActionText>{t('shell.search.seeAll', { group: title })}</ActionText>,
            },
          ]
        : [];
    return [{ key: type, title, items: [...items, ...more] }];
  });
}
