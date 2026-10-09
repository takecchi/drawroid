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
