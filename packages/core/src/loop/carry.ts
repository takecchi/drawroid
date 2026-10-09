import { clipText } from '../budget/estimate.js';
import type { Budget } from './budget.js';
import type { JudgeOutput, ThinkParams } from './schemas.js';

/** ある回で点数のいちばん高かった画像と、その回の決定・評価 */
export type CarriedResult = {
  iteration: number;
  imageIndex: number;
  score: number;
  params: ThinkParams;
  issues: string[];
  nextChange: string;
};

/**
 * 回をまたいで LLM に渡る唯一の材料。欄の数は固定で、どの欄も上限付き。
 */
// 過去の回の配列を持たない: 入力が回数に比例して膨らみ、ローカル LLM のコンテキストを溢れさせるため。
// 過去の回はファイルと UI にだけ残す
export type Carry = {
  intent: string;
  completedIterations: number;
  best?: CarriedResult;
  latest?: CarriedResult;
  /** 人間が添えた参照画像の要点（新しい順に件数の上限まで）。画像そのものは持ち回さない */
  references?: CarriedReference[];
};

export type CarriedReference = { refId: string; gist: string };

/** 見る役の評価。人間が選んだ回は、見る役を通さずに作った評価で、選んだ画像を最良候補に据える印が付く */
export type StageJudgement = JudgeOutput & { adopted?: true };

export function createCarry(
  request: string,
  budget: Budget,
): { carry: Carry; intentClippedFrom?: number } {
  const intent = clipText(request, budget.text.intent);
  return {
    carry: { intent: intent.text, completedIterations: 0 },
    ...(intent.clippedFrom === undefined ? {} : { intentClippedFrom: intent.clippedFrom }),
  };
}

export function advanceCarry(
  carry: Carry,
  iteration: number,
  params: ThinkParams,
  judgement: StageJudgement,
): Carry {
  const latest = topResult(iteration, params, judgement);
  if (latest === undefined) return { ...carry, completedIterations: iteration };
  // 人間が選んだ画像は、点数が並んでも最良候補にする: 満点どうしの同点で、先の画像に負けないため
  const best =
    judgement.adopted === true || carry.best === undefined || latest.score > carry.best.score
      ? latest
      : carry.best;
  return { ...carry, completedIterations: iteration, best, latest };
}

/** 人間が選んだ画像（点数 1）を最良候補にする。最新の結果には触れない */
export function adoptAsBest(
  carry: Carry,
  adopted: { iteration: number; imageIndex: number; params: ThinkParams; issues: string[] },
): Carry {
  return { ...carry, best: { ...adopted, score: 1, nextChange: '' } };
}

function topResult(
  iteration: number,
  params: ThinkParams,
  judgement: JudgeOutput,
): CarriedResult | undefined {
  let top: { index: number; score: number; issues: string[] } | undefined;
  judgement.images.forEach((image, index) => {
    if (top === undefined || image.score > top.score) top = { index, ...image };
  });
  if (top === undefined) return undefined;
  return {
    iteration,
    imageIndex: top.index,
    score: top.score,
    params,
    issues: top.issues,
    nextChange: judgement.nextChange,
  };
}
