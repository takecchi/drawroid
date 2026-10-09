import { REPEATED_TOOL_CALL_REASON, TOOL_THREW_PREFIX } from '@drawroid/core';

// 話す役のツールの、人が読む呼び方。知らない名前（あとから足したツールなど）は名前のまま出す
const TOOL_TITLES: Record<string, string> = {
  start_drawing: '描き始める',
  revise_drawing: '描いている絵に伝える',
  stop_drawing: '描くのを止める',
  adopt_image: '画像を選ぶ',
  review_image: '画像を見る役に見せる',
  drawing_status: '描いている絵の様子を見る',
  search_candidates: '候補を探す',
  describe_backend: 'バックエンドを確かめる',
  recall_memory: '記憶を引く',
  remember: '覚える',
};

export function toolTitle(name: string): string | undefined {
  return TOOL_TITLES[name];
}

const SUMMARY_MAX = 80;

// ジョブの ID（置き場所が付ける名前の形: 20261009-215155-2b6f3e）
const JOB_ID = String.raw`\d{8}-\d{6}-[0-9a-z]+`;

/**
 * 要約からジョブの ID を省く。結果の文は話す役に返すためのもので ID を含むが、人が読む要約には要らないため（全文は「詳しく」に残す）。
 * 「ジョブ <ID> で描き始めた」→「ジョブで描き始めた」、「（ジョブ <ID>）」→ 消す、「（ジョブ <ID> の見る役が…）」→「（見る役が…）」
 */
function withoutJobIds(text: string): string {
  return text
    .replace(new RegExp(`（ジョブ ${JOB_ID}）`, 'g'), '')
    .replace(new RegExp(`ジョブ ${JOB_ID} の`, 'g'), '')
    .replace(new RegExp(`ジョブ ${JOB_ID} ?`, 'g'), 'ジョブ')
    .replace(new RegExp(` ?${JOB_ID} ?`, 'g'), '');
}

/** 最初の一文（「。」まで）。長ければ切る */
function firstSentence(text: string): string {
  const end = text.indexOf('。');
  const sentence = end < 0 ? text : text.slice(0, end + 1);
  return sentence.length <= SUMMARY_MAX ? sentence : `${sentence.slice(0, SUMMARY_MAX)}…`;
}

/**
 * ツールの結果の、人が読む短い要約。全文は「詳しく」に残す。
 * 同じ呼び出しを重ねたときの断りは、作り手向けの文なので、人の言葉に置き換える
 */
export function summarizeToolResult(
  state: 'running' | 'ok' | 'error',
  summary: string | undefined,
): string | undefined {
  if (state === 'running' || summary === undefined) return undefined;
  if (state === 'error') {
    // ツールが投げた失敗は、実行器が頭に「失敗した: 」を付けて記録する。外してから読む
    const reason = summary.startsWith(TOOL_THREW_PREFIX)
      ? summary.slice(TOOL_THREW_PREFIX.length)
      : summary;
    return reason === REPEATED_TOOL_CALL_REASON
      ? '同じ呼び出しはこのターンで済んでいたので、もう一度はしなかった。'
      : `できなかった: ${firstSentence(withoutJobIds(reason))}`;
  }
  return firstSentence(withoutJobIds(summary));
}
