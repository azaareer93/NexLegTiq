import { PlusOutlined } from '@ant-design/icons';
import type { Client } from '@nexlegtiq/shared-contracts';
import { Bdi } from '@nexlegtiq/shared-ui';
import { Button, Divider, Select } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useClientsList } from '../api/use-clients';
import { useDebounced } from '../list-params';
import { ClientDrawer } from './ClientDrawer';

/** A client as the picker shows it. */
export interface PickedClient {
  readonly id: string;
  readonly displayName: string;
}

export interface ClientSelectProps {
  /** The picked client's id (works as an AntD `Form.Item` control). */
  readonly value?: string;
  readonly onChange?: (id: string | undefined, client?: PickedClient) => void;
  /** The picked client's name, when `value` comes from outside (an edited record). */
  readonly initialClient?: PickedClient;
  readonly 'data-testid'?: string;
}

/**
 * Picks an active client by searching the server as you type, or creates one on the spot (MVP-59's quick-create):
 * "New client" opens the client drawer with what was typed, and the new client is picked.
 */
export function ClientSelect({
  value,
  onChange,
  initialClient,
  'data-testid': testId = 'client-select',
}: ClientSelectProps): React.JSX.Element {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  // The name the drawer starts with: taken on the click, since closing the dropdown clears the search.
  const [creating, setCreating] = useState<string | null>(null);
  const [picked, setPicked] = useState<PickedClient | undefined>();
  const search = useDebounced(text.trim());
  const list = useClientsList(
    { isActive: 'true', limit: '20', ...(search ? { search } : {}) },
    open,
  );

  const options = (list.data?.items ?? []).map((client) => ({
    value: client.id,
    label: client.displayName,
  }));
  // The current value keeps its name when the search no longer lists it: picked here, or given by the form (also when
  // the form provides it only after loading).
  const shown = [picked, initialClient].find(
    (client) => client !== undefined && client.id === value,
  );
  if (shown && !options.some((option) => option.value === shown.id)) {
    options.unshift({ value: shown.id, label: shown.displayName });
  }

  const pick = (client: PickedClient | undefined) => {
    setPicked(client);
    onChange?.(client?.id, client);
  };

  return (
    <>
      <Select<string>
        value={value}
        allowClear
        open={open}
        onOpenChange={setOpen}
        placeholder={t('clients.select.placeholder')}
        aria-label={t('clients.select.placeholder')}
        showSearch={{ filterOption: false, searchValue: text, onSearch: setText }}
        loading={list.isFetching}
        notFoundContent={list.isFetching ? null : t('clients.select.noResults')}
        options={options}
        onChange={(id) => {
          const option = options.find((candidate) => candidate.value === id);
          pick(option ? { id: option.value, displayName: option.label } : undefined);
        }}
        popupRender={(menu) => (
          <>
            {menu}
            <Divider style={{ margin: '4px 0' }} />
            <Button
              type="text"
              block
              icon={<PlusOutlined />}
              style={{ textAlign: 'start' }}
              onClick={() => {
                setCreating(text.trim());
                setOpen(false);
              }}
              data-testid={`${testId}-create`}
            >
              {t('clients.select.create')}
              {text.trim() ? (
                <>
                  {' '}
                  <Bdi>{text.trim()}</Bdi>
                </>
              ) : null}
            </Button>
          </>
        )}
        data-testid={testId}
      />
      <ClientDrawer
        open={creating !== null}
        clientId={null}
        initialName={creating ?? ''}
        onClose={() => setCreating(null)}
        onCreated={(client: Client) => {
          setCreating(null);
          setText('');
          pick({ id: client.id, displayName: client.displayName });
        }}
      />
    </>
  );
}
