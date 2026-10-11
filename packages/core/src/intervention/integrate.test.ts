import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET } from '../loop/budget.js';
import { createCarry } from '../loop/carry.js';
import type { ThinkOutput } from '../loop/schemas.js';
import { applyIntegratedIntent } from './integrate.js';

const budget = DEFAULT_BUDGET;
const limit = budget.text.intent;
const carry = createCarry('夕暮れの海辺に立つ少女', budget).carry;

const integrated = (intent: string): ThinkOutput => ({
  params: { prompt: 'girl, beach' },
  rationale: '指示どおり逆光にする',
  intent,
});

describe('applyIntegratedIntent', () => {
  it('keeps an integrated intent of exactly the limit as it is', () => {
    const intent = 'あ'.repeat(limit);
    expect(applyIntegratedIntent(carry, integrated(intent), budget).intent).toBe(intent);
  });

  it('clips an integrated intent longer than the limit, so the carry stays bounded', () => {
    const next = applyIntegratedIntent(carry, integrated('あ'.repeat(limit + 50)), budget);
    expect(next.intent).toBe('あ'.repeat(limit));
  });
});
