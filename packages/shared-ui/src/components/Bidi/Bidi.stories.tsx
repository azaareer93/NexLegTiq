import { ArrowLeftOutlined, ArrowRightOutlined } from '@ant-design/icons';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { DirectionalIcon } from '../DirectionalIcon/DirectionalIcon';
import { Bdi, Ltr } from './Bidi';

const meta = { title: 'Text/Bidi', component: Ltr, args: { children: '' } } satisfies Meta<typeof Ltr>;
export default meta;
type Story = StoryObj<typeof meta>;

function Mixed(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Typography.Paragraph>
      {t('legal.fileNumber')}: <Ltr>2026-LIT-00001</Ltr> · {t('auth.fields.email')}: <Ltr>office@example.test</Ltr> ·{' '}
      {t('legal.client')}: <Bdi>Omar Haddad</Bdi>
    </Typography.Paragraph>
  );
}

export const NumbersAndEmailsInText: Story = { render: () => <Mixed /> };

export const MirroredIcons: Story = {
  render: () => (
    <Typography.Text>
      <DirectionalIcon icon={ArrowLeftOutlined} /> <DirectionalIcon icon={ArrowRightOutlined} />
    </Typography.Text>
  ),
};
