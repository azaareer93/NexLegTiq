import { ArrowLeftOutlined, ArrowRightOutlined, CheckOutlined, RightOutlined, UndoOutlined } from '@ant-design/icons';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Flex, Typography } from 'antd';

import { DirectionalIcon } from './DirectionalIcon';

const meta = { title: 'Text/DirectionalIcon', component: DirectionalIcon, args: { icon: ArrowLeftOutlined } } satisfies Meta<
  typeof DirectionalIcon
>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Arrows, chevrons and undo flip in Arabic; the plain check mark shows what does not. */
export const MirroredInRtl: Story = {
  render: () => (
    <Flex gap={16}>
      <DirectionalIcon icon={ArrowLeftOutlined} />
      <DirectionalIcon icon={ArrowRightOutlined} />
      <DirectionalIcon icon={RightOutlined} />
      <DirectionalIcon icon={UndoOutlined} />
      <Typography.Text>
        <CheckOutlined />
      </Typography.Text>
    </Flex>
  ),
};
