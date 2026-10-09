import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  Badge,
  BulletList,
  Button,
  CheckboxField,
  CodeBlock,
  DescriptionList,
  Disclosure,
  ErrorNote,
  Field,
  FieldRow,
  FieldSet,
  Input,
  Item,
  ItemList,
  Muted,
  OkNote,
  Section,
  Select,
  SubSection,
  Textarea,
  WarnNote,
} from './common';

const meta = {
  title: 'UI/Common',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Buttons: Story = {
  render: () => (
    <FieldRow>
      <Button variant="primary">投入する</Button>
      <Button>送る</Button>
      <Button variant="ghost">閉じる</Button>
      <Button variant="danger">ジョブを止める</Button>
      <Button disabled>押せない</Button>
    </FieldRow>
  ),
};

export const Badges: Story = {
  render: () => (
    <FieldRow>
      <Badge tone="ok">走行中</Badge>
      <Badge tone="warn">待ち</Badge>
      <Badge tone="muted">終了</Badge>
      <Badge>手動</Badge>
      <Badge tone="danger">失敗</Badge>
    </FieldRow>
  ),
};

export const Form: Story = {
  render: () => (
    <Section title="生成">
      <form className="space-y-3" onSubmit={(event) => event.preventDefault()}>
        <Field label="prompt" wide>
          <Textarea rows={3} placeholder="例: 夕暮れの海" />
        </Field>
        <FieldRow>
          <Field label="checkpoint">
            <Select defaultValue="">
              <option value="">Forge の既定</option>
            </Select>
          </Field>
          <Field label="steps">
            <Input inputMode="numeric" defaultValue="20" className="w-24" />
          </Field>
          <Field label="seed" hint="空ならランダム">
            <Input inputMode="numeric" className="w-36" />
          </Field>
        </FieldRow>
        <FieldSet legend="止める条件">
          <CheckboxField label="AI が意図どおりと判断したら止める" defaultChecked />
          <FieldRow>
            <Field label="回数の上限">
              <Input inputMode="numeric" defaultValue="10" className="w-24" />
            </Field>
            <Field label="時間の上限（分）">
              <Input inputMode="numeric" placeholder="なし" className="w-24" />
            </Field>
          </FieldRow>
        </FieldSet>
        <Button type="submit" variant="primary">
          生成する
        </Button>
      </form>
    </Section>
  ),
};

export const Notes: Story = {
  render: () => (
    <div className="space-y-2">
      <ErrorNote>送れない: バックエンドに繋がらない（http://127.0.0.1:7860）</ErrorNote>
      <WarnNote>入力が長いので途中で切って読んだ</WarnNote>
      <OkNote>送った。次の回の「考える」から反映される</OkNote>
      <Muted>まだ画像は無い。</Muted>
    </div>
  ),
};

export const Sections: Story = {
  render: () => (
    <Section title="操作" action={<Badge tone="ok">走行中</Badge>}>
      <SubSection title="止める">
        <Button variant="danger">ジョブを止める</Button>
      </SubSection>
      <SubSection title="止める条件">
        <BulletList>
          <li>AI が意図どおりと判断したら</li>
          <li>10 回まで</li>
        </BulletList>
      </SubSection>
    </Section>
  ),
};

export const Lists: Story = {
  render: () => (
    <Section title="走行中（2）">
      <ItemList>
        <Item>
          <a href="#job-1" className="font-mono text-primary underline-offset-4 hover:underline">
            job-1
          </a>
          <Badge tone="ok">走行中</Badge>
          <span>自動</span>
          <span className="text-muted-foreground">2026/10/9 15:00:00</span>
        </Item>
        <Item>
          <a href="#job-2" className="font-mono text-primary underline-offset-4 hover:underline">
            job-2
          </a>
          <Badge tone="muted">終了</Badge>
          <span>手動</span>
        </Item>
      </ItemList>
    </Section>
  ),
};

export const Details: Story = {
  render: () => (
    <Section title="依頼">
      <DescriptionList>
        <dt>種類</dt>
        <dd>自動</dd>
        <dt>状態</dt>
        <dd>
          <Badge tone="ok">走行中</Badge>
        </dd>
        <dt>生成した枚数</dt>
        <dd>12</dd>
      </DescriptionList>
      <Disclosure summary="パラメータ">
        <CodeBlock>{JSON.stringify({ prompt: '夕暮れの海', steps: 20 }, null, 2)}</CodeBlock>
      </Disclosure>
    </Section>
  ),
};
