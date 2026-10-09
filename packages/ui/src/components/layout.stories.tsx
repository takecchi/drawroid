import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  Brain,
  Images,
  ListTodo,
  MessageSquare,
  ScrollText,
  Settings2,
  ShieldCheck,
  Tags,
} from 'lucide-react';
import { useState } from 'react';

import { AppSidebar, Drawer, MobileTopBar, type AppSidebarItem } from './app-shell';
import { Section } from './common';
import { Page } from './layout';

const meta = {
  title: 'Layout/AppShell',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const ITEMS: AppSidebarItem[] = [
  { to: '#conversations', label: '会話', icon: MessageSquare },
  { to: '#new-job', label: '依頼', icon: Images, section: '描く' },
  { to: '#jobs', label: 'ジョブ', icon: ListTodo, section: '描く' },
  { to: '#memory', label: '記憶', icon: Brain, section: '覚える' },
  { to: '#candidates', label: '候補の説明', icon: Tags, section: '覚える' },
  { to: '#generate', label: '生成と設定', icon: Settings2, section: '設定' },
  { to: '#permissions', label: '許可', icon: ShieldCheck, section: '設定' },
  { to: '#llm-calls', label: 'LLM の記録', icon: ScrollText, section: '設定' },
];

function Links({ inDrawer = false }: { inDrawer?: boolean }) {
  return (
    <AppSidebar
      items={ITEMS}
      inDrawer={inDrawer}
      renderLink={(item, slot) => (
        <a href={item.to} className={slot.className(item.to === '#jobs')}>
          {slot.children}
        </a>
      )}
    />
  );
}

function Body() {
  return (
    <Page title="ジョブ">
      <Section title="走行中（1）">
        <p className="text-sm">ページの中身は枠（Section）に入れて縦に積む。</p>
      </Section>
      <Section title="待ち（0）">
        <p className="text-sm">枠どうしの間は Page が空ける。</p>
      </Section>
    </Page>
  );
}

export const Wide: Story = {
  render: () => (
    <div className="flex min-h-dvh">
      <Links />
      <div className="min-w-0 flex-1">
        <Body />
      </div>
    </div>
  ),
};

function NarrowDemo() {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-dvh">
      <MobileTopBar onOpenNav={() => setOpen(true)} />
      <Drawer open={open} onClose={() => setOpen(false)} label="行き先">
        <Links inDrawer />
      </Drawer>
      <Body />
    </div>
  );
}

export const Narrow: Story = {
  parameters: { viewport: { defaultViewport: 'mobile1' } },
  render: () => <NarrowDemo />,
};
