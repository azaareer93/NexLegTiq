import { PRIORITIES } from '@nexlegtiq/shared-types';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Flex } from 'antd';
import { useTranslation } from 'react-i18next';

import { PriorityTag, StatusTag } from './StatusTag';

const meta = {
  title: 'Display/StatusTag',
  component: StatusTag,
  args: { tone: 'success', children: '' },
} satisfies Meta<typeof StatusTag>;
export default meta;
type Story = StoryObj<typeof meta>;

function Tones(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Flex gap={8} wrap>
      <StatusTag tone="success">{t('legal.settlement')}</StatusTag>
      <StatusTag tone="info">{t('legal.session')}</StatusTag>
      <StatusTag tone="warning">{t('legal.adjourned')}</StatusTag>
      <StatusTag tone="error">{t('legal.conflictOfInterest')}</StatusTag>
      <StatusTag tone="neutral">{t('legal.timeline')}</StatusTag>
    </Flex>
  );
}

export const AllTones: Story = { render: () => <Tones /> };

export const Priorities: Story = {
  render: () => (
    <Flex gap={8} wrap>
      {PRIORITIES.map((priority) => (
        <PriorityTag key={priority} priority={priority} />
      ))}
    </Flex>
  ),
};
