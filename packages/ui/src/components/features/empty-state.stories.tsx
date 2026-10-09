import type { Meta, StoryObj } from '@storybook/react-vite';
import { ImageOff } from 'lucide-react';

import { Button } from '../common';
import { EmptyState } from './empty-state';

const meta = {
  title: 'Features/EmptyState',
  component: EmptyState,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TitleOnly: Story = { args: { title: 'まだ無い。' } };

export const WithIconAndAction: Story = {
  args: {
    icon: ImageOff,
    title: 'まだ画像は無い。',
    description: '最初の回の生成が終わると、ここに並ぶ。',
    action: <Button variant="primary">依頼する</Button>,
  },
};
