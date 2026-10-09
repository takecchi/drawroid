import { packWithinBudget } from '../../budget/pack.js';
import { estimateTextTokens } from '../../budget/estimate.js';
import { sealMessages, type BudgetNote, type BudgetedMessages } from '../../llm/port.js';
import type { ModelWindow } from '../../loop/budget.js';
import { InputOverBudgetError, SectionWriter, type Section } from '../../loop/inputs.js';
import type { ConversationEvent } from '../events.js';
import type { TalkLimits } from './limits.js';

const TALK_SYSTEM = [
  'あなたは画像生成を手伝う話す役。人間と日本語で短く話す。',
  '分からないこと・調べられることは、ツールで調べてから答える。推測で断定しない。',
].join('\n');

const FINAL_STEP = 'ステップの上限に達した。ツールは使わず、ここまでの結果で人間に返答する。';

/** このターンの中で、前のステップまでに起きたこと。次のステップの入力に載せる */
export type TalkStepRecord = {
  /** そのステップで話す役が書いた本文（ツールを呼ぶ前の前置きなど） */
  text: string;
  tool?: { name: string; input: unknown; result: string };
};

/**
 * 話す役への1回の入力。会話の長さにもジョブの回数にも比例して増えない。
 * - 直近のやりとり: 人間の発言と話す役の本文だけを、新しい方から件数で絞り、1件ずつ文字数で切る。思考とツールの記録は入れない
 * - このターンで読む人間の発言は落とさない。ほかの発言は、入力の上限に入らなければ古い方から落とす
 * - 会話のジョブの状態と、このターンのステップ（ツールの結果は文字数で切る）
 */
export function buildTalkInput(args: {
  events: readonly ConversationEvent[];
  /** このターンで読む人間の発言の seq */
  messageSeqs: readonly number[];
  /** 会話のジョブの状態の短い文（無ければ省く） */
  job?: string;
  steps: readonly TalkStepRecord[];
  /** 最後のステップ。ツールを渡さず返答させる */
  final: boolean;
  limits: TalkLimits;
  window: ModelWindow;
}): BudgetedMessages {
  const { limits, window } = args;
  const w = new SectionWriter();
  const unread = new Set(args.messageSeqs);
  // 思考（assistant.reasoning）とツールの記録は拾わない: 思考を入力に戻さず、前のターンの結果は本文で足りるため
  const said = args.events.filter(
    (e): e is Extract<ConversationEvent, { type: 'user.message' | 'assistant.message' }> =>
      e.type === 'user.message' || e.type === 'assistant.message',
  );
  const recent = said.slice(-limits.recentMessages);
  const notes: BudgetNote[] = [];
  if (said.length > recent.length) {
    notes.push({
      kind: 'dropped',
      section: 'messages',
      reason: `直近の ${limits.recentMessages} 件より前の発言 ${said.length - recent.length} 件は渡さない`,
    });
  }
  const toSection = (e: (typeof said)[number]): Section & { seq: number } => {
    const who =
      e.type === 'user.message'
        ? '人間'
        : e.interrupted
          ? '話す役（途中で打ち切られた）'
          : '話す役';
    return {
      seq: e.seq,
      name: `message[${e.seq}]`,
      text: `${who}: ${w.clip(`message[${e.seq}]`, e.text, limits.messageChars)}`,
    };
  };
  // このターンで読む発言は、直近の件数から外れても必ず載せる: 答えるべき発言が黙って消えないように
  const required = said.filter((e) => unread.has(e.seq)).map(toSection);
  const optional = recent.filter((e) => !unread.has(e.seq)).map(toSection);

  const fixed: Section[] = [];
  if (args.job !== undefined) {
    fixed.push({ name: 'job', text: `会話のジョブ: ${w.clip('job', args.job, limits.jobChars)}` });
  }
  const steps: Section[] = args.steps.map((step, i) => {
    const lines = [];
    if (step.text !== '')
      lines.push(`話す役: ${w.clip(`step[${i}].text`, step.text, limits.messageChars)}`);
    if (step.tool !== undefined) {
      lines.push(
        `ツール ${step.tool.name}（${JSON.stringify(step.tool.input)}）の結果: ${w.clip(`step[${i}].result`, step.tool.result, limits.toolResultChars)}`,
      );
    }
    return { name: `step[${i}]`, text: lines.join('\n') };
  });
  const trailing: Section[] = args.final ? [{ name: 'final', text: FINAL_STEP }] : [];

  const inputTokenLimit = window.contextTokens - window.maxOutputTokens;
  const size = (s: Section) => estimateTextTokens(s.text) + 1;
  const fixedTokens =
    estimateTextTokens(TALK_SYSTEM) +
    [...fixed, ...required, ...steps, ...trailing].reduce((sum, s) => sum + size(s), 0);
  if (fixedTokens > inputTokenLimit) throw new InputOverBudgetError(fixedTokens, inputTokenLimit);
  // 入力の上限に入らないときは、古い発言から落とす
  const packed = packWithinBudget(optional, {
    size,
    compare: (a, b) => b.seq - a.seq,
    limits: { maxSize: inputTokenLimit - fixedTokens },
  });
  const kept = new Set(packed.included.map((s) => s.seq));
  const messages = [...optional.filter((s) => kept.has(s.seq)), ...required].sort(
    (a, b) => a.seq - b.seq,
  );
  const text = [
    ...(messages.length === 0 ? [] : ['直近のやりとり:', ...messages.map((s) => s.text)]),
    ...fixed.map((s) => s.text),
    ...(steps.length === 0 ? [] : ['このターンでしたこと:', ...steps.map((s) => s.text)]),
    ...trailing.map((s) => s.text),
  ].join('\n');
  return sealMessages(TALK_SYSTEM, [{ type: 'text', text }], {
    estimatedInputTokens: fixedTokens + packed.usedSize,
    inputTokenLimit,
    notes: [
      ...notes,
      ...w.notes,
      ...packed.dropped.map(({ item }) => ({
        kind: 'dropped' as const,
        section: item.name,
        reason: '入力の上限に入らない',
      })),
    ],
  });
}
