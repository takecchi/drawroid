/**
 * 予算の欄の、日本語の短い説明とまとまり。欄の名前（内部名、例: text.intent）は設定ファイルの鍵と同じなので消さず、説明に添えて小さく出す。
 * 「量」は、件数とは別の、載せる中身の大きさの上限（文字数を見積もった量）
 */
const LABELS: Record<string, string> = {
  'text.intent': '依頼の要点の文字数',
  'text.prompt': 'プロンプトの文字数',
  'text.negativePrompt': 'ネガティブプロンプトの文字数',
  'text.rationale': '考える役が添える理由の文字数',
  'text.issue': '見る役が挙げる問題点1件の文字数',
  'text.nextChange': '見る役が書く「次に変えること」の文字数',
  issuesPerImage: '画像1枚に挙げる問題点の件数',
  imageLongEdge: 'LLM に見せる縮小画像の長辺（px）',
  imagesPerJudge: '見る役に1回で見せる画像の枚数',
  'candidates.maxCount': '考える役に見せる候補（checkpoint・LoRA など）の件数',
  'candidates.maxSize': '考える役に見せる候補の量',
  'interventions.maxCount': '1回に取り込む人の指示の件数',
  'interventions.maxSize': '1回に取り込む人の指示の量',
  'interventions.textEach': '人の指示1件の文字数',
  'references.maxCount': '参照画像の枚数',
  'references.gistChars': '参照画像の要点の文字数',
  'references.noteChars': '参照画像に添えた言葉の文字数',
  'memory.think.maxCount': '考える役に渡す記憶の件数',
  'memory.think.maxSize': '考える役に渡す記憶の量',
  'memory.think.always.maxCount': '考える役に渡す「いつも効く記憶」の件数',
  'memory.think.always.maxSize': '考える役に渡す「いつも効く記憶」の量',
  'memory.judge.maxCount': '見る役に渡す記憶の件数',
  'memory.judge.maxSize': '見る役に渡す記憶の量',
  'memory.judge.always.maxCount': '見る役に渡す「いつも効く記憶」の件数',
  'memory.judge.always.maxSize': '見る役に渡す「いつも効く記憶」の量',
  'distill.intentChars': '学びに渡す依頼の要点の文字数',
  'distill.stopDetailChars': '学びに渡す止まった理由の文字数',
  'distill.interventions.maxCount': '学びに渡す人の指示の件数',
  'distill.interventions.maxSize': '学びに渡す人の指示の量',
  'distill.interventionChars': '学びに渡す人の指示1件の文字数',
  'distill.messages.maxCount': '学びに渡す会話の発言の件数',
  'distill.messages.maxSize': '学びに渡す会話の発言の量',
  'distill.messageChars': '学びに渡す会話の発言1件の文字数',
  'distill.selections.maxCount': '学びに渡す人の選んだ画像の件数',
  'distill.issuesPerSelection': '学びに渡す選んだ画像1枚の問題点の件数',
  'distill.issueChars': '学びに渡す問題点1件の文字数',
  'distill.memory.maxCount': '学びに渡す今の記憶の件数',
  'distill.memory.maxSize': '学びに渡す今の記憶の量',
  'distill.memory.always.maxCount': '学びに渡す「いつも効く記憶」の件数',
  'distill.memory.always.maxSize': '学びに渡す「いつも効く記憶」の量',
  'distill.output.operations': '1回の学びで書き換える記憶の件数',
  'distill.output.body': '学んだ記憶1件の文字数',
  'distill.output.tags': '学んだ記憶1件のタグの数',
  'distill.output.tag': 'タグ1つの文字数',
  'talk.recentMessages': '話す役に見せる直近の発言の件数',
  'talk.messageChars': '話す役に見せる発言1件の文字数',
  'talk.jobChars': '話す役に見せる描いている絵の要約の文字数',
  'talk.maxSteps': '話す役が1回の返事で道具を使える回数',
  'talk.toolResultChars': '話す役に見せる道具の結果1件の文字数',
  'talk.candidates.maxCount': '話す役が候補を調べたときに返す件数',
  'talk.candidates.maxSize': '話す役が候補を調べたときに返す量',
  'talk.memory.maxCount': '話す役が記憶を引いたときに返す件数',
  'talk.memory.maxSize': '話す役が記憶を引いたときに返す量',
};

/** 欄の日本語の説明。知らない欄（予算に新しく足した欄など）は undefined */
export function budgetLabel(path: string): string | undefined {
  return LABELS[path];
}

/** 欄のまとまり。内部名の頭で分ける */
export const BUDGET_GROUPS = [
  {
    title: '文字数と画像',
    matches: (path: string) =>
      path.startsWith('text.') ||
      ['issuesPerImage', 'imageLongEdge', 'imagesPerJudge'].includes(path),
  },
  { title: '候補', matches: (path: string) => path.startsWith('candidates.') },
  { title: '人の指示', matches: (path: string) => path.startsWith('interventions.') },
  { title: '参照画像', matches: (path: string) => path.startsWith('references.') },
  { title: '記憶', matches: (path: string) => path.startsWith('memory.') },
  { title: '学び（記憶を書き足す）', matches: (path: string) => path.startsWith('distill.') },
  { title: '会話（話す役）', matches: (path: string) => path.startsWith('talk.') },
] as const;

/** 欄をまとまりに分ける。どのまとまりにも入らない欄は「そのほか」に入れる（欄が黙って消えないように） */
export function groupBudgetLeaves<T extends { path: string }>(
  leaves: readonly T[],
): { title: string; leaves: T[] }[] {
  const groups = BUDGET_GROUPS.map((group) => ({
    title: group.title as string,
    leaves: leaves.filter((leaf) => group.matches(leaf.path)),
  }));
  const rest = leaves.filter((leaf) => !BUDGET_GROUPS.some((group) => group.matches(leaf.path)));
  return [...groups, ...(rest.length > 0 ? [{ title: 'そのほか', leaves: rest }] : [])].filter(
    (group) => group.leaves.length > 0,
  );
}
