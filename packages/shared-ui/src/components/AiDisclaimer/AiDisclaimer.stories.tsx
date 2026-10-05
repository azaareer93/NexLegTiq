import type { Meta, StoryObj } from '@storybook/react-vite';

import { AiDisclaimer } from './AiDisclaimer';

const meta = { title: 'AI/AiDisclaimer', component: AiDisclaimer } satisfies Meta<typeof AiDisclaimer>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
