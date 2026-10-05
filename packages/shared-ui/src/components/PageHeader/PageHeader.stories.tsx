import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from 'antd';
import { useTranslation } from 'react-i18next';

import { Ltr } from '../Bidi/Bidi';
import { PriorityTag } from '../StatusTag/StatusTag';
import { PageHeader } from './PageHeader';

const meta = { title: 'Layout/PageHeader', component: PageHeader, args: { title: '' } } satisfies Meta<typeof PageHeader>;
export default meta;
type Story = StoryObj<typeof meta>;

function CasePage(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <PageHeader
      onBack={() => undefined}
      title={t('legal.legalFile')}
      subtitle={
        <>
          {t('legal.fileNumber')}: <Ltr>2026-LIT-00001</Ltr>
        </>
      }
      extra={
        <>
          <PriorityTag priority="HIGH" />
          <Button>{t('common.actions.edit')}</Button>
          <Button type="primary">{t('common.actions.save')}</Button>
        </>
      }
    />
  );
}

export const WithBackAndActions: Story = { render: () => <CasePage /> };
