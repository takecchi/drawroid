import { describe, expect, it } from 'vitest';
import {
  integrateInterventions,
  InterventionNotIntegratedError,
} from '../intervention/integrate.js';
import {
  DEFAULT_INTERVENTION_LIMITS,
  pendingInterventions,
  type Intervention,
} from '../intervention/intervention.js';
import { planInterventions } from '../intervention/plan.js';
import type { BudgetedMessages } from '../llm/port.js';
import { toLlmCallRecord } from '../llm/record.js';
import { DEFAULT_BUDGET, DEFAULT_MODEL_WINDOW } from './budget.js';
import { createCarry, type Carry } from './carry.js';
import { buildThinkInput } from './inputs.js';
import { buildThinkOutputSchema, THINK_PARAM_KEYS, type ThinkOutput } from './schemas.js';

const budget = DEFAULT_BUDGET;
const window = DEFAULT_MODEL_WINDOW;
const limits = DEFAULT_INTERVENTION_LIMITS;
const full = (limit: number) => 'あ'.repeat(limit);

function said(id: string, text: string, n: number): Intervention {
  return { id, text, receivedAt: new Date(Date.UTC(2026, 9, 9, 0, 0, n)).toISOString() };
}

function think(carry: Carry, interventions: readonly Intervention[], iteration: number) {
  const plan = planInterventions(interventions, limits);
  const messages = buildThinkInput({
    carry,
    progress: { iteration },
    allowed: THINK_PARAM_KEYS,
    budget,
    window,
    interventions: plan,
  });
  return { plan, messages };
}

function textOf(messages: BudgetedMessages): string {
  return messages.user.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
}

const decided = (intent?: string): ThinkOutput => ({
  params: { prompt: 'girl, beach' },
  rationale: '指示どおり逆光にする',
  ...(intent === undefined ? {} : { intent }),
});

describe('taking interventions into the next think', () => {
  it('records an intervention as a human instruction, apart from the AI judgement (M3:99)', () => {
    const carry = createCarry('夕暮れの海辺に立つ少女', budget).carry;
    const { messages } = think(carry, [said('a', '逆光にして', 1)], 2);
    const record = toLlmCallRecord({
      callId: 'c1',
      jobId: 'j1',
      iteration: 2,
      role: 'think',
      purpose: 'think',
      provider: 'openai-compatible',
      model: 'qwen',
      startedAt: new Date('2026-10-09T00:00:00Z'),
      messages,
      outcome: { ok: true, value: decided('逆光の夕暮れの海辺に立つ少女'), attempts: [] },
    });
    const recorded = record.input.user
      .flatMap((p) => (p.type === 'text' ? [p.text] : []))
      .join('\n');
    const [beforeHuman, humanSection] = recorded.split('人間の指示:');
    expect(humanSection).toContain('逆光にして');
    expect(beforeHuman).not.toContain('逆光にして');
  });

  it('marks which iteration took each intervention in, and keeps its original text', () => {
    const carry = createCarry('夕暮れの海辺に立つ少女', budget).carry;
    const interventions = [said('a', '逆光にして', 1)];
    const { plan } = think(carry, interventions, 2);
    const next = integrateInterventions({
      carry,
      interventions,
      plan,
      output: decided('逆光の夕暮れの海辺に立つ少女'),
      iteration: 2,
      budget,
    });
    expect(next.interventions).toEqual([{ ...interventions[0], appliedInIteration: 2 }]);
    expect(next.carry.intent).toBe('逆光の夕暮れの海辺に立つ少女');
    expect(textOf(think(next.carry, next.interventions, 3).messages)).not.toContain('人間の指示');
  });

  it('keeps carried-over interventions pending until a later think takes them in', () => {
    let carry = createCarry('海辺の少女', budget).carry;
    let interventions = [1, 2, 3, 4, 5].map((n) => said(`i${n}`, `指示${n}`, n));
    for (const iteration of [2, 3]) {
      const { plan } = think(carry, interventions, iteration);
      ({ carry, interventions } = integrateInterventions({
        carry,
        interventions,
        plan,
        output: decided(`要点${iteration}`),
        iteration,
        budget,
      }));
    }
    expect(interventions.map((i) => i.appliedInIteration)).toEqual([2, 2, 2, 3, 3]);
    expect(pendingInterventions(interventions)).toEqual([]);
  });

  it('never lets the think input exceed its budget, however many interventions arrive (M3:100)', () => {
    let carry = createCarry(full(budget.text.intent * 2), budget).carry;
    let interventions: Intervention[] = [];
    const estimated = new Map<number, number>();
    for (let iteration = 2; iteration <= 50; iteration += 1) {
      for (let k = 0; k < 5; k += 1) {
        interventions.push(
          said(`i${iteration}-${k}`, full(limits.textEach * 2), iteration * 10 + k),
        );
      }
      const { plan, messages } = think(carry, interventions, iteration);
      expect(messages.report.estimatedInputTokens).toBeLessThanOrEqual(
        messages.report.inputTokenLimit,
      );
      estimated.set(iteration, messages.report.estimatedInputTokens);
      ({ carry, interventions } = integrateInterventions({
        carry,
        interventions,
        plan,
        output: decided(full(budget.text.intent)),
        iteration,
        budget,
      }));
    }
    // 回の番号の桁が揃う回どうしで比べる: 進捗の行の長さが桁の数だけ違うため
    expect(estimated.get(50)).toBe(estimated.get(10));
  });

  it('asks for the integrated intent only when interventions are included', () => {
    const output = { params: { prompt: 'girl' }, rationale: 'x' };
    expect(() =>
      buildThinkOutputSchema(['prompt'], budget, { withInterventions: true }).parse(output),
    ).toThrow();
    expect(buildThinkOutputSchema(['prompt'], budget).parse({ ...output, intent: '要点' })).toEqual(
      output,
    );
  });

  it('refuses to mark interventions taken in when the think returned no integrated intent', () => {
    const carry = createCarry('海辺の少女', budget).carry;
    const interventions = [said('a', '逆光にして', 1)];
    const { plan } = think(carry, interventions, 2);
    expect(() =>
      integrateInterventions({
        carry,
        interventions,
        plan,
        output: decided(),
        iteration: 2,
        budget,
      }),
    ).toThrow(InterventionNotIntegratedError);
  });
});
