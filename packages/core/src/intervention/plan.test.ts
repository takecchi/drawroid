import { describe, expect, it } from 'vitest';
import type { InstructionIntervention, InterventionRecord } from '../job/types.js';
import type { InterventionLimits } from './intervention.js';
import { planInterventions } from './plan.js';

const limits: InterventionLimits = { maxCount: 3, maxSize: 30, textEach: 10 };

const at = (minute: number) => `2026-10-09T00:${String(minute).padStart(2, '0')}:00Z`;

function said(interventionId: string, text: string, minute: number): InstructionIntervention {
  return { kind: 'instruction', interventionId, text, receivedAt: at(minute) };
}

const idsOf = (items: readonly { interventionId: string }[]) =>
  items.map((item) => item.interventionId);

describe('planInterventions', () => {
  it('includes pending interventions in the order they were received', () => {
    const plan = planInterventions([said('b', '背景は夜', 2), said('a', '逆光に', 1)], limits);
    expect(plan.included).toEqual([
      { interventionId: 'a', text: '逆光に' },
      { interventionId: 'b', text: '背景は夜' },
    ]);
    expect(plan.carried).toEqual([]);
  });

  it('does not include interventions already taken into an earlier think', () => {
    const plan = planInterventions(
      [{ ...said('a', '逆光に', 1), appliedInIteration: 2 }, said('b', '背景は夜', 2)],
      limits,
    );
    expect(idsOf(plan.included)).toEqual(['b']);
  });

  it('leaves stop condition changes out of the think, since they never go through the LLM', () => {
    const change: InterventionRecord = {
      kind: 'stopConditions',
      interventionId: 's',
      receivedAt: at(1),
      stopConditions: { maxIterations: 3 },
    };
    const plan = planInterventions([change, said('a', '逆光に', 2)], limits);
    expect(idsOf(plan.included)).toEqual(['a']);
    expect(plan.notes).toEqual([]);
  });

  it('clips a long intervention and records that it was clipped', () => {
    const plan = planInterventions([said('a', 'あ'.repeat(25), 1)], limits);
    expect(plan.included[0]?.text).toBe('あ'.repeat(10));
    expect(plan.notes).toContainEqual({
      kind: 'clipped',
      section: 'interventions.a',
      from: 25,
      to: 10,
    });
  });

  it('carries over what does not fit the count, and records the carry-over', () => {
    const many = [1, 2, 3, 4, 5].map((n) => said(`i${n}`, `指示${n}`, n));
    const plan = planInterventions(many, limits);
    expect(idsOf(plan.included)).toEqual(['i1', 'i2', 'i3']);
    expect(idsOf(plan.carried)).toEqual(['i4', 'i5']);
    expect(plan.notes.filter((n) => n.kind === 'dropped').map((n) => n.section)).toEqual([
      'interventions.i4',
      'interventions.i5',
    ]);
  });

  it('never lets a later intervention overtake one that was carried over', () => {
    const plan = planInterventions(
      [
        said('a', 'あ'.repeat(10), 1),
        said('b', 'い'.repeat(10), 2),
        said('c', 'う'.repeat(10), 3),
        said('d', '短い', 4),
      ],
      { maxCount: 5, maxSize: 25, textEach: 10 },
    );
    expect(idsOf(plan.included)).toEqual(['a', 'b']);
    expect(idsOf(plan.carried)).toEqual(['c', 'd']);
  });

  it('always takes in the oldest intervention, even if one is longer than the whole limit', () => {
    const plan = planInterventions([said('a', 'あ'.repeat(50), 1)], {
      maxCount: 3,
      maxSize: 20,
      textEach: 40,
    });
    expect(plan.included).toEqual([{ interventionId: 'a', text: 'あ'.repeat(20) }]);
  });
});
