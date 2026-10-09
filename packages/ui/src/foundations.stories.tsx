import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

const meta = {
  title: 'Foundations',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const SWATCHES = [
  { token: 'background', className: 'bg-background', role: '画面の地' },
  { token: 'card', className: 'bg-card', role: '枠の面' },
  { token: 'foreground', className: 'bg-foreground', role: '本文の文字' },
  { token: 'muted-foreground', className: 'bg-muted-foreground', role: '補足の文字' },
  { token: 'primary', className: 'bg-primary', role: '主な操作' },
  { token: 'destructive', className: 'bg-destructive', role: '失敗・取り返しのつかない操作' },
  { token: 'ok', className: 'bg-ok', role: '成功' },
  { token: 'warn', className: 'bg-warn', role: '注意' },
  { token: 'human', className: 'bg-human', role: '人間の操作' },
  { token: 'ai', className: 'bg-ai', role: 'AI の判断' },
] as const;

const TEXT_SIZES = [
  { className: 'text-2xl', label: '見出し（text-2xl）' },
  { className: 'text-base', label: '本文（text-base）' },
  { className: 'text-sm', label: '補足（text-sm）' },
  { className: 'text-xs', label: '注記（text-xs）' },
] as const;

const RADII = ['rounded-sm', 'rounded-md', 'rounded-lg', 'rounded-xl'] as const;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Colors() {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
      {SWATCHES.map((swatch) => (
        <div key={swatch.token} className="space-y-2">
          <div className={cn('h-16 rounded-md ring-1 ring-foreground/10', swatch.className)} />
          <div>
            <div className="font-mono text-xs">{swatch.token}</div>
            <div className="text-xs text-muted-foreground">{swatch.role}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function Typography() {
  return (
    <div className="space-y-2">
      {TEXT_SIZES.map((size) => (
        <p key={size.className} className={size.className}>
          {size.label} 絵を描く・Draw a picture
        </p>
      ))}
      <p className="font-mono text-xs text-muted-foreground">
        font-mono: 2026-10-09T02:14:09Z job-7f3c2a91
      </p>
    </div>
  );
}

function Radii() {
  return (
    <div className="flex gap-4">
      {RADII.map((radius) => (
        <div key={radius} className="space-y-1">
          <div className={cn('size-16 bg-muted ring-1 ring-foreground/10', radius)} />
          <div className="font-mono text-xs text-muted-foreground">{radius}</div>
        </div>
      ))}
    </div>
  );
}

function Overview() {
  return (
    <div className="min-h-dvh bg-background p-6 text-foreground sm:p-10">
      <div className="mx-auto flex max-w-4xl flex-col gap-10">
        <h1 className="text-2xl font-semibold">Foundations</h1>
        <Section title="色">
          <Colors />
        </Section>
        <Section title="文字の大きさ">
          <Typography />
        </Section>
        <Section title="角丸">
          <Radii />
        </Section>
      </div>
    </div>
  );
}

export const Default: Story = { render: () => <Overview /> };
