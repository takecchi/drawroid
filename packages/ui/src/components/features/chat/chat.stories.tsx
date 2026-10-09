import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';

import { Button } from '../../common';
import { MobileTopBar } from '../../app-shell';
import {
  ChatComposer,
  ChatLayout,
  ChatLog,
  ConversationSummary,
  GenerationProgress,
  ImageRow,
  JobStartCard,
  JudgeNote,
  MessageRow,
  ReasoningBlock,
  StatusLine,
  StopNotice,
  ThinkNote,
  ToolCallCard,
} from './index';

const meta = {
  title: 'Features/Chat',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// 外へ取りに行かない見本の画像: Storybook を手元だけで開けるようにするため
function sample(from: string, to: string) {
  return (
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="512" height="512" fill="url(#g)"/></svg>`,
    )
  );
}

const IMAGES = [
  sample('#fbbf24', '#7c2d12'),
  sample('#f9a8d4', '#581c87'),
  sample('#93c5fd', '#1e3a8a'),
];

function SmallButtons() {
  return (
    <div className="flex gap-1">
      <Button className="h-7 px-2 text-xs">お気に入り</Button>
      <Button className="h-7 px-2 text-xs">却下</Button>
    </div>
  );
}

const jobLink = (
  <a href="#job" className="text-xs text-primary underline-offset-4 hover:underline">
    ジョブの詳細
  </a>
);

function ConversationScreen() {
  const [value, setValue] = useState('');
  return (
    <ChatLayout
      header={<span className="font-medium">夕暮れの海辺の少女</span>}
      log={
        <ChatLog followKey={0}>
          <MessageRow author="human" meta="15:30">
            夕暮れの海辺に立つ少女、描けますか？
          </MessageRow>
          <ReasoningBlock>
            質問なので、まだ描かない。使える checkpoint と LoRA を確かめてから答える。
          </ReasoningBlock>
          <ToolCallCard
            name="list_capabilities"
            args="kind: checkpoint, lora"
            state="ok"
            result="checkpoint 3件・LoRA 12件（風景・逆光の LoRA あり）"
          />
          <MessageRow author="ai">
            描けます。風景向けの checkpoint と、逆光の LoRA が使えます。描きましょうか？
          </MessageRow>
          <MessageRow author="human" meta="15:31">
            お願い。柔らかい光で
          </MessageRow>
          <ToolCallCard
            name="start_drawing"
            args="request: 夕暮れの海辺に立つ少女。柔らかい光で / 5 回まで"
            state="ok"
            result="ジョブ 20261009-153112-k3f9 を作った"
          />
          <MessageRow author="ai">描きます。</MessageRow>
          <JobStartCard
            request="夕暮れの海辺に立つ少女。柔らかい光で"
            conditions={['AI が意図どおりと判断したら', '5 回まで']}
            permissions="prompt・seed・steps を AI に任せる"
            link={jobLink}
          />
          <ThinkNote
            iteration={1}
            rationale="逆光の LoRA を弱めに足し、夕焼けの色を prompt に入れる"
            changes={['LoRA backlight 0.6', 'steps 28']}
          />
          <ImageRow
            iteration={1}
            link={jobLink}
            images={IMAGES.map((src, index) => ({
              key: String(index),
              href: src,
              src,
              alt: `1 回目の画像 ${index}`,
              score: ['0.62', '0.48', '0.55'][index],
              issues: index === 1 ? ['手の形が崩れている'] : ['空の色が強すぎる'],
              verdict: index === 0 ? 'favorite' : null,
              actions: <SmallButtons />,
            }))}
          />
          <JudgeNote iteration={1} canStop={false} nextChange="空の彩度を下げ、手を隠す構図に" />
          <GenerationProgress iteration={2} progress={0.35} step={7} steps={20} etaMs={5200} />
          <MessageRow author="human" meta="15:33">
            あ、1枚目でいいから、次は髪をなびかせて
          </MessageRow>
          <StatusLine status="job.held" />
        </ChatLog>
      }
      composer={
        <ChatComposer
          value={value}
          onChange={setValue}
          onSend={() => setValue('')}
          onStop={() => undefined}
          running
        />
      }
    />
  );
}

/** オーナーの例: 質問には調べて答え、指示では描き、評価の最中に割り込む */
export const Conversation: Story = {
  render: () => <ConversationScreen />,
};

/** 狭い幅（携帯）で、上の帯の下に会話の画面を置いたもの。入力欄が画面の下に収まる */
export const ConversationNarrow: Story = {
  globals: { viewport: { value: 'mobile2', isRotated: false } },
  render: () => (
    <>
      <MobileTopBar onOpenNav={() => undefined} />
      <ConversationScreen />
    </>
  ),
};

export const Messages: Story = {
  render: () => (
    <ChatLog followKey={0}>
      <MessageRow author="human" meta="15:30">
        何ができますか？
      </MessageRow>
      <MessageRow author="ai">
        絵を描けます。描いてほしいものを言葉で伝えてください。{'\n'}
        途中の画像に口を出したり、いつでも止めたりできます。
      </MessageRow>
      <MessageRow author="ai" streaming>
        いま返しているところの本文
      </MessageRow>
      <MessageRow author="ai" truncated>
        割り込まれて途中で止まった本文
      </MessageRow>
      <MessageRow
        author="human"
        meta="プロセスの再起動で応答が途切れた"
        action={<Button className="h-6 px-2 text-xs">送り直す</Button>}
      >
        続きを描いて
      </MessageRow>
    </ChatLog>
  ),
};

/** 思考は流れている間は開き、確定したら畳まれる（3秒後に確定する） */
export const ReasoningStreaming: Story = {
  render: () => {
    const [text, setText] = useState('');
    const full =
      'まず依頼が質問か指示かを見分ける。「描けますか」は質問なので、描き始めずに、使えるものを調べて答える。';
    const streaming = text.length < full.length;
    useEffect(() => {
      if (!streaming) return;
      const timer = setTimeout(() => setText(full.slice(0, text.length + 3)), 80);
      return () => clearTimeout(timer);
    }, [text, streaming]);
    return (
      <div className="space-y-3 p-6">
        <ReasoningBlock streaming={streaming}>{text}</ReasoningBlock>
        <ReasoningBlock label="見る役の思考">
          確定したものは畳まれている。押すと開く。
        </ReasoningBlock>
      </div>
    );
  },
};

export const Tools: Story = {
  render: () => (
    <div className="space-y-3 p-6">
      <ToolCallCard name="recall_memory" args="tags: 風景, 色" state="running" />
      <ToolCallCard name="list_capabilities" args="kind: lora" state="ok" result="LoRA 12件" />
      <ToolCallCard
        name="start_drawing"
        args="request: …"
        state="error"
        result="走っているジョブがあるので、新しく始められない"
      />
    </div>
  ),
};

export const Progress: Story = {
  render: () => (
    <div className="space-y-3 p-6">
      <GenerationProgress iteration={2} progress={0.35} step={7} steps={20} etaMs={5200} />
      <GenerationProgress
        iteration={2}
        progress={0.6}
        step={12}
        steps={20}
        etaMs={3100}
        previewSrc={IMAGES[0]}
      />
      <GenerationProgress iteration={3} />
    </div>
  ),
};

export const Notices: Story = {
  render: () => (
    <div className="space-y-3 p-6">
      <JudgeNote iteration={3} canStop />
      <JudgeNote iteration={2} canStop={false} adopted={{ iteration: 2, number: 1 }} />
      <StopNotice tone="done">止まった: AI が意図どおりと判断</StopNotice>
      <StopNotice tone="stopped">止まった: 人間が止めた</StopNotice>
      <StopNotice tone="error" action={<Button className="h-6 px-2 text-xs">送り直す</Button>}>
        応答が失敗した: LLM に繋がらない
      </StopNotice>
      <StatusLine status="queued" />
      <StatusLine status="waiting-llm" />
      <StatusLine status="job.held" />
    </div>
  ),
};

export const Composer: Story = {
  render: () => {
    const [value, setValue] = useState('あ、1枚目でいいから');
    return (
      <div className="space-y-6 p-6">
        <ChatComposer value={value} onChange={setValue} onSend={() => setValue('')} />
        <ChatComposer
          value={value}
          onChange={setValue}
          onSend={() => setValue('')}
          onStop={() => undefined}
          running
        />
      </div>
    );
  },
};

export const List: Story = {
  render: () => (
    <ul className="max-w-xl divide-y divide-border p-6">
      <li className="py-3">
        <ConversationSummary
          title="夕暮れの海辺の少女"
          preview="あ、1枚目でいいから、次は髪をなびかせて"
          running
          meta="15:33"
        />
      </li>
      <li className="py-3">
        <ConversationSummary title="何ができますか？" preview="絵を描けます。" meta="昨日" />
      </li>
    </ul>
  ),
};
