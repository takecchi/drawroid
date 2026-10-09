/**
 * 呼び出す前のトークン数の見積もり。多めに出す。
 * ASCII は3文字で1トークン、それ以外（日本語など）は1文字で1トークンとみなす。
 */
// tokenizer を使わない: provider ごとに違い、ローカルモデルでは手に入らないことが多いため。
// 実際の数は呼び出しの記録（usage）で測る
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 3) + other;
}

/** 長辺 L の画像を正方形とみなし、1トークンあたり 750px² で見積もる（多めに出す） */
export function estimateImageTokens(longEdge: number): number {
  return Math.ceil((longEdge * longEdge) / 750);
}

export type Clipped = { text: string; clippedFrom?: number };

/** 文字数の上限で切る。切ったら元の長さを返す（記録に残すため） */
export function clipText(text: string, limit: number): Clipped {
  const chars = [...text];
  if (chars.length <= limit) return { text };
  return { text: chars.slice(0, limit).join(''), clippedFrom: chars.length };
}
