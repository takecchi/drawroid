import type { Meta, StoryObj } from '@storybook/react-vite';

import { Markdown } from './markdown';

const meta = {
  title: 'Features/Markdown',
  component: Markdown,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Markdown>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Reply: Story = {
  args: {
    children: [
      '## 次の回の案',
      '',
      '**夕暮れの海辺**に立つ少女を、*逆光*で描きます。',
      '',
      '- 髪は風になびかせる',
      '- 空は橙から紺へ',
      '',
      '| 回 | 点 | 直すこと |',
      '| - | - | - |',
      '| 1 | 0.62 | 指が崩れている |',
      '| 2 | 0.81 | 背景が暗い |',
      '',
      '```json',
      '{ "prompt": "1girl, long hair, beach, sunset, backlighting, wind, white dress, very long line that scrolls" }',
      '```',
      '',
      '参考: [Stable Diffusion のプロンプト](https://example.com/prompt-guide)',
    ].join('\n'),
  },
};

// 生の HTML は文字のまま、危ない URL は link にしない
export const UnsafeInput: Story = {
  args: {
    children: [
      '<script>alert(1)</script>',
      '',
      '[押す](javascript:alert(1))',
      '',
      '![外の画像](https://example.com/sea.png)',
    ].join('\n'),
  },
};
