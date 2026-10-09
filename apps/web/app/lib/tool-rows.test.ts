import { REPEATED_TOOL_CALL_REASON, TOOL_THREW_PREFIX } from '@drawroid/core';
import { describe, expect, it } from 'vitest';

import { summarizeToolResult, toolTitle } from './tool-rows';

describe('toolTitle', () => {
  it('gives the human title of a tool, and nothing for one it does not know', () => {
    expect(toolTitle('start_drawing')).toBe('描き始める');
    expect(toolTitle('revise_drawing')).toBe('描いている絵に伝える');
    expect(toolTitle('new_tool')).toBeUndefined();
  });
});

describe('summarizeToolResult', () => {
  it('keeps only the first sentence of the result', () => {
    expect(
      summarizeToolResult('ok', 'ジョブ j1 で描き始めた。止める条件: AI の判断・6 回まで'),
    ).toBe('ジョブ j1 で描き始めた。');
  });

  it('cuts a long first sentence', () => {
    expect(summarizeToolResult('ok', 'あ'.repeat(100))).toBe(`${'あ'.repeat(80)}…`);
  });

  it('says it could not, with the first sentence of the reason', () => {
    expect(summarizeToolResult('error', '描いている絵が無い。新しく描くなら start_drawing')).toBe(
      'できなかった: 描いている絵が無い。',
    );
  });

  // 作り手向けの断りの文は、人の言葉に置き換える（全文は「詳しく」に残る）
  it('puts a repeated call into words a person reads', () => {
    expect(summarizeToolResult('error', REPEATED_TOOL_CALL_REASON)).toBe(
      '同じ呼び出しはこのターンで済んでいたので、もう一度はしなかった。',
    );
  });

  // 会話の記録には、実行器が頭の言葉を付けた形で残る（core の runner.test.ts が、この形を縛る）
  it('reads a repeated call as it is recorded, with the words the runner puts in front', () => {
    expect(summarizeToolResult('error', `${TOOL_THREW_PREFIX}${REPEATED_TOOL_CALL_REASON}`)).toBe(
      '同じ呼び出しはこのターンで済んでいたので、もう一度はしなかった。',
    );
  });

  it('does not say it failed twice when a tool threw', () => {
    expect(summarizeToolResult('error', `${TOOL_THREW_PREFIX}記憶の置き場所に書けない。`)).toBe(
      'できなかった: 記憶の置き場所に書けない。',
    );
  });

  it('has nothing to say while the tool runs', () => {
    expect(summarizeToolResult('running', undefined)).toBeUndefined();
  });
});

// 人が読む要約には、ジョブの ID を出さない（結果の文は話す役に返すもので、ID を含む。全文は「詳しく」に残る）。
// 文は、本物の置き場所・実行器で描く道具と評価の道具を回して、会話の記録に残った summary を写したもの
describe('summarizeToolResult and job IDs', () => {
  it.each([
    [
      'ok',
      'ジョブ 20261009-222644-6484ae で描き始めた。止める条件: 1000 回まで',
      'ジョブで描き始めた。',
    ],
    [
      'ok',
      'ジョブ 20261009-222644-6484ae に指示を伝えた（次の回の境目から効く）',
      'ジョブに指示を伝えた（次の回の境目から効く）',
    ],
    ['ok', 'ジョブ 20261009-222644-6484ae を止めた', 'ジョブを止めた'],
    [
      'error',
      'ジョブ 20261009-222644-6484ae がまだ描いている。直すなら revise_drawing、やめて描き直すなら stop_drawing のあとで start_drawing を呼ぶ',
      'できなかった: ジョブがまだ描いている。',
    ],
    [
      'error',
      '99 回目の 1枚目の画像は無い（ジョブ 20261009-222644-f9ac3c）',
      'できなかった: 99 回目の 1枚目の画像は無い',
    ],
    [
      'error',
      '1 回目の 1枚目はまだ評価中（ジョブ 20261009-222644-bc2852 の見る役が見ている）',
      'できなかった: 1 回目の 1枚目はまだ評価中（見る役が見ている）',
    ],
    [
      'error',
      'ジョブ 20261009-222644-3a2b3a には評価に使う要約が無い',
      'できなかった: ジョブには評価に使う要約が無い',
    ],
    // 道具が投げた失敗（実行器が頭の言葉を付けて残す）
    [
      'error',
      `${TOOL_THREW_PREFIX}ジョブ 20261009-222644-6484ae への口出しは受けられない: 重ねると AI の判断も上限も無くなり、ジョブが止まらなくなる`,
      'できなかった: ジョブへの口出しは受けられない: 重ねると AI の判断も上限も無くなり、ジョブが止まらなくなる',
    ],
  ] as const)('leaves the job ID out of %s: %s', (state, summary, short) => {
    expect(summarizeToolResult(state, summary)).toBe(short);
  });

  // ID の形でない数や名前は、要約に残す
  it.each(['記憶 3 件', 'lora の候補 12 件（ほかに 2026 件）', 'ジョブ j1 で描き始めた。'])(
    'keeps what is not a job ID: %s',
    (summary) => {
      expect(summarizeToolResult('ok', summary)).toBe(summary);
    },
  );
});
