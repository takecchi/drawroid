import { describe, expect, it } from 'vitest';

import { estimateTextTokens } from '../budget/estimate.js';
import { DEFAULT_BUDGET } from './budget.js';
import { estimateMaxOutputTokens } from './output-estimate.js';

describe('estimateMaxOutputTokens', () => {
  it('counts the think output filled up to its text limits, more than the old default of 1024', () => {
    const { think } = estimateMaxOutputTokens(DEFAULT_BUDGET);
    const t = DEFAULT_BUDGET.text;
    // 英数字の prompt・negativePrompt と、日本語の理由・要点の分は少なくとも入る
    expect(think).toBeGreaterThanOrEqual(
      estimateTextTokens('a'.repeat(t.prompt + t.negativePrompt)) + t.rationale + t.intent,
    );
    expect(think).toBeGreaterThan(1024);
  });

  it('counts the judge output for as many images as one call carries', () => {
    const one = estimateMaxOutputTokens({ ...DEFAULT_BUDGET, imagesPerJudge: 1 }).judge;
    const four = estimateMaxOutputTokens({ ...DEFAULT_BUDGET, imagesPerJudge: 4 }).judge;
    const perImage = DEFAULT_BUDGET.issuesPerImage * DEFAULT_BUDGET.text.issue;
    expect(four - one).toBeGreaterThanOrEqual(3 * perImage);
  });
});
