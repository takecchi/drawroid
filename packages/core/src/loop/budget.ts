export type TextLimits = {
  /** 依頼の要点 */
  intent: number;
  prompt: number;
  negativePrompt: number;
  /** 考える役が決定に添える理由 */
  rationale: number;
  /** 見る役が画像1枚に挙げる問題点の1件 */
  issue: number;
  /** 見る役が次に変えるべきこととして書く短文 */
  nextChange: number;
};

export type Budget = {
  text: TextLimits;
  /** 見る役が画像1枚に挙げる問題点の件数 */
  issuesPerImage: number;
  /** LLM に渡す縮小版の長辺（px） */
  imageLongEdge: number;
  /** 見る役の1回の呼び出しに載せる画像の枚数 */
  imagesPerJudge: number;
};

export const DEFAULT_BUDGET: Budget = {
  text: {
    intent: 600,
    prompt: 600,
    negativePrompt: 300,
    rationale: 200,
    issue: 80,
    nextChange: 200,
  },
  issuesPerImage: 3,
  imageLongEdge: 512,
  imagesPerJudge: 4,
};

/** 呼び出す役のモデルの窓。役割の設定から来る */
export type ModelWindow = {
  contextTokens: number;
  maxOutputTokens: number;
};

export const DEFAULT_MODEL_WINDOW: ModelWindow = {
  contextTokens: 8192,
  maxOutputTokens: 1024,
};
