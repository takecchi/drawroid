import type { Meta, StoryObj } from '@storybook/react-vite';

import { StatusBadge, type StatusMap } from './status-badge';

type JobStatus = 'running' | 'queued' | 'stopped';

const JOB_STATUS: StatusMap<JobStatus> = {
  running: { tone: 'ok', label: '走行中' },
  queued: { tone: 'warn', label: '待ち' },
  stopped: { tone: 'muted', label: '止まった' },
};

const meta = {
  title: 'Features/StatusBadge',
  component: StatusBadge,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof StatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Running: Story = { args: { status: 'running', map: JOB_STATUS } };
export const Queued: Story = { args: { status: 'queued', map: JOB_STATUS } };
export const Stopped: Story = { args: { status: 'stopped', map: JOB_STATUS } };
// サーバが画面の知らない値を返したとき
export const Unknown: Story = { args: { status: 'paused', map: JOB_STATUS } };
