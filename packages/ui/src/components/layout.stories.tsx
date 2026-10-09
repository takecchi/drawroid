import type { Meta, StoryObj } from '@storybook/react-vite';

import { Section } from './common';
import { Page, SiteHeader, siteNavLinkClass } from './layout';

const meta = {
  title: 'Layout/Page',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const LINKS = [
  { href: '#generate', label: '生成', active: false },
  { href: '#request', label: '依頼', active: true },
  { href: '#jobs', label: 'ジョブ', active: false },
  { href: '#memory', label: '記憶', active: false },
];

export const WithHeader: Story = {
  render: () => (
    <>
      <SiteHeader brand="drawroid">
        {LINKS.map((link) => (
          <a
            key={link.href}
            href={link.href}
            className={siteNavLinkClass({ isActive: link.active })}
          >
            {link.label}
          </a>
        ))}
      </SiteHeader>
      <Page title="依頼">
        <Section title="止める条件">
          <p className="text-sm">ページの中身は枠（Section）に入れて縦に積む。</p>
        </Section>
        <Section title="参照画像">
          <p className="text-sm">枠どうしの間は Page が空ける。</p>
        </Section>
      </Page>
    </>
  ),
};
