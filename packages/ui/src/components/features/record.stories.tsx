import type { Meta, StoryObj } from '@storybook/react-vite';

import { Badge, Button, DescriptionList, FieldRow } from '../common';
import { AuthorMark, ImageCard, ImageGrid } from './record';

const meta = {
  title: 'Features/Record',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// 外へ取りに行かない見本の画像: Storybook を手元だけで開けるようにするため
const SAMPLE =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f59e0b"/><stop offset="1" stop-color="#1e3a8a"/></linearGradient></defs><rect width="512" height="512" fill="url(#g)"/></svg>',
  );

export const Authors: Story = {
  render: () => (
    <div className="space-y-2">
      <AuthorMark author="human" label="人間の指示" meta="2026/10/9 15:00:00">
        <p className="whitespace-pre-wrap">もっと逆光で</p>
      </AuthorMark>
      <AuthorMark author="ai" label="AI（考える役）" as="section">
        <h4 className="text-sm font-semibold">考える役の決定</h4>
        <DescriptionList>
          <dt>prompt</dt>
          <dd>sunset beach, backlight</dd>
          <dt>steps</dt>
          <dd>28</dd>
        </DescriptionList>
        <p>理由: 逆光の指示を取り込んだ</p>
      </AuthorMark>
    </div>
  ),
};

function Controls() {
  return (
    <FieldRow className="gap-2">
      <Button className="h-7 px-2 text-xs">お気に入り</Button>
      <Button className="h-7 px-2 text-xs">却下</Button>
    </FieldRow>
  );
}

export const Images: Story = {
  render: () => (
    <ImageGrid>
      <ImageCard href={SAMPLE} src={SAMPLE} alt="seed 1" caption={<>seed 1 / score 0.82</>}>
        <Controls />
      </ImageCard>
      <ImageCard href={SAMPLE} src={SAMPLE} alt="seed 2" verdict="favorite" caption="seed 2">
        <Badge tone="ok">お気に入り</Badge>
      </ImageCard>
      <ImageCard href={SAMPLE} src={SAMPLE} alt="seed 3" verdict="rejected" caption="seed 3">
        <Badge tone="muted">却下</Badge>
      </ImageCard>
    </ImageGrid>
  ),
};
