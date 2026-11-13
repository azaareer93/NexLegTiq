import { EditOutlined } from '@ant-design/icons';
import { ClientSchema } from '@nexlegtiq/shared-contracts';
import type { Client, InvoiceSummary } from '@nexlegtiq/shared-contracts';
import { isErrorCode } from '@nexlegtiq/shared-types';
import {
  Bdi,
  ErrorState,
  isApiError,
  LoadingSkeleton,
  Ltr,
  PageHeader,
  useApiErrorHandler,
  useCan,
  useFormat,
} from '@nexlegtiq/shared-ui';
import { Button, Card, Col, Descriptions, Flex, Row, Statistic, Tabs, Tag } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import { ComingSoonTab } from '../../cases/components/ComingSoonTab';
import { NotesTab } from '../../cases/notes/NotesTab';
import { NotFoundPage } from '../../shell/components/status-pages';
import { useClientInvoiceSummary } from '../api/use-client-profile';
import { useClient } from '../api/use-clients';
import { ClientDrawer } from '../components/ClientDrawer';
import { ClientDocumentsTab, ClientFilesTab, ClientInvoicesTab } from '../components/ClientTabs';
import { ContactsEditor } from '../components/ContactsEditor';

const TABS = ['overview', 'files', 'documents', 'invoices', 'notes', 'portal'] as const;
type ClientTab = (typeof TABS)[number];

/** Amounts per currency, one per line (never added across currencies, D-162); "—" when there are none. */
function Amounts({ rows }: { readonly rows: InvoiceSummary['billed'] }): React.JSX.Element {
  const format = useFormat();
  if (rows.length === 0) return <>—</>;
  return (
    <Flex vertical>
      {rows.map((row) => (
        <Bdi key={row.currency}>{format.money(row.amount, row.currency)}</Bdi>
      ))}
    </Flex>
  );
}

/** One key number of the overview. */
function Stat({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Col xs={12} md={6}>
      <Card size="small" data-testid={`client-stat-${id}`}>
        <Statistic title={title} valueRender={() => children} />
      </Card>
    </Col>
  );
}

/** Details, the key numbers and the contact persons (the editor manages them in place, D-108). */
function Overview({
  client,
  money,
}: {
  readonly client: Client;
  readonly money: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const summary = useClientInvoiceSummary(client.id, money);
  return (
    <Flex vertical gap={16}>
      <Row gutter={[16, 16]}>
        <Stat id="open" title={t('clients.profile.stats.openFiles')}>
          {format.number(client.openFiles)}
        </Stat>
        <Stat id="closed" title={t('clients.profile.stats.closedFiles')}>
          {format.number(client.closedFiles)}
        </Stat>
        {money && summary.data ? (
          <>
            <Stat id="billed" title={t('clients.profile.stats.billed')}>
              <Amounts rows={summary.data.billed} />
            </Stat>
            <Stat id="outstanding" title={t('clients.profile.stats.outstanding')}>
              <Amounts rows={summary.data.outstanding} />
            </Stat>
          </>
        ) : null}
      </Row>
      <Card title={t('clients.profile.details')}>
        <Descriptions column={{ xs: 1, md: 2 }}>
          <Descriptions.Item label={t('clients.fields.clientType')}>
            {t(`enums.clientType.${client.clientType}`)}
          </Descriptions.Item>
          <Descriptions.Item label={t('clients.fields.phone')}>
            {client.phone ? <Ltr>{client.phone}</Ltr> : '—'}
          </Descriptions.Item>
          <Descriptions.Item label={t('clients.fields.email')}>
            {client.email ? <Ltr>{client.email}</Ltr> : '—'}
          </Descriptions.Item>
          <Descriptions.Item label={t('clients.fields.address')}>
            {client.address ? <Bdi>{client.address}</Bdi> : '—'}
          </Descriptions.Item>
          <Descriptions.Item label={t('clients.profile.primaryLawyer')}>
            {client.primaryLawyer ? <Bdi>{client.primaryLawyer.fullName}</Bdi> : '—'}
          </Descriptions.Item>
          <Descriptions.Item label={t('clients.profile.since')}>
            {format.date(client.createdAt)}
          </Descriptions.Item>
        </Descriptions>
      </Card>
      <Card>
        <ContactsEditor client={client} headingLevel={2} />
      </Card>
    </Flex>
  );
}

function ClientView({ client }: { readonly client: Client }): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState(false);
  const canAll = useCan('view:all:invoices');
  const canAssigned = useCan('view:assigned:invoices');
  const money = canAll || canAssigned;
  const tabs = TABS.filter((key) => key !== 'invoices' || money);
  const tab: ClientTab = tabs.find((key) => key === params.get('tab')) ?? 'overview';

  // Replace, not push: the back button leaves the client instead of walking through its tabs.
  const selectTab = (key: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (key === 'overview') next.delete('tab');
        else next.set('tab', key);
        return next;
      },
      { replace: true },
    );

  const content = (key: ClientTab): React.ReactNode => {
    if (key === 'overview') return <Overview client={client} money={money} />;
    if (key === 'files') return <ClientFilesTab clientId={client.id} />;
    if (key === 'documents') return <ClientDocumentsTab clientId={client.id} />;
    if (key === 'invoices') return <ClientInvoicesTab clientId={client.id} />;
    if (key === 'notes') {
      // Anyone here may write a confidential client note: its author keeps reading it (D-168).
      return (
        <NotesTab subject={{ clientId: client.id }} canWrite canConfidential readOnly={false} />
      );
    }
    return <ComingSoonTab />;
  };

  return (
    <section data-testid="page-client">
      <PageHeader
        title={<Bdi>{client.displayName}</Bdi>}
        subtitle={
          <Flex gap={8} align="center" wrap>
            {t(`enums.clientType.${client.clientType}`)}
            {client.isActive ? null : <Tag>{t('clients.list.inactive')}</Tag>}
          </Flex>
        }
        onBack={() => void navigate('/clients')}
        extra={
          <Button
            icon={<EditOutlined />}
            onClick={() => setEditing(true)}
            data-testid="client-edit"
          >
            {t('common.actions.edit')}
          </Button>
        }
      />
      <Tabs
        activeKey={tab}
        onChange={selectTab}
        items={tabs.map((key) => ({
          key,
          label: <span data-testid={`client-tab-${key}`}>{t(`clients.profile.tabs.${key}`)}</span>,
          children: content(key),
        }))}
      />
      <ClientDrawer
        open={editing}
        clientId={client.id}
        contacts={false}
        onClose={() => setEditing(false)}
      />
    </section>
  );
}

/**
 * `/clients/:id?tab=` (MVP-55, frontend.md#client-profile): everything about one client; tabs load when first opened.
 * A client of another office, a deleted one or a malformed id is the 404 page (D-019).
 */
export function ClientPage(): React.JSX.Element {
  const { id = '' } = useParams();
  const valid = ClientSchema.shape.id.safeParse(id).success;
  const client = useClient(valid ? id : null);
  const { referenceOf } = useApiErrorHandler();
  const code = isApiError(client.error) ? client.error.code : undefined;
  if (!valid || code === 'RES-001') return <NotFoundPage />;
  if (client.data) return <ClientView client={client.data} />;
  if (client.isError) {
    return (
      <ErrorState
        code={code !== undefined && isErrorCode(code) ? code : undefined}
        requestId={referenceOf(client.error)}
        onRetry={() => void client.refetch()}
      />
    );
  }
  return <LoadingSkeleton rows={8} />;
}
