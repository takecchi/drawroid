import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET, type Budget } from '../loop/budget.js';
import { createCarry } from '../loop/carry.js';
import type { ThinkOutput } from '../loop/schemas.js';
import { applyIntegratedIntent } from './integrate.js';

const budget: Budget = { ...DEFAULT_BUDGET, text: { ...DEFAULT_BUDGET.text, intent: 10 } };
const carry = createCarry('海辺の少女', budget).carry;

const integrated = (intent: string): ThinkOutput => ({
  params: { prompt: 'girl, beach' },
  rationale: '指示どおり逆光にする',
  intent,
});

describe('applyIntegratedIntent', () => {
  it('keeps an integrated intent of exactly the limit as it is', () => {
    expect(applyIntegratedIntent(carry, integrated('逆光の海辺に立つ少女'), budget).intent).toBe(
      '逆光の海辺に立つ少女',
    );
  });

  it('clips an integrated intent longer than the limit, so the carry stays bounded', () => {
    expect(
      applyIntegratedIntent(carry, integrated('逆光の夕暮れの海辺に立つ少女'), budget).intent,
    ).toBe('逆光の夕暮れの海辺に');
  });
});
