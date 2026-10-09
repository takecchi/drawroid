import { clipText } from '../budget/estimate.js';
import { packWithinBudget } from '../budget/pack.js';
import type { InstructionIntervention, InterventionRecord } from '../job/types.js';
import type { BudgetNote } from '../llm/port.js';
import { pendingInterventions, type InterventionLimits } from './intervention.js';

/** 次の「考える」に載せる人間の指示。text は上限で切ったもの */
export type PlannedIntervention = { interventionId: string; text: string };

export type InterventionPlan = {
  /** 載せるもの（受けた順） */
  included: PlannedIntervention[];
  /** 入りきらず、次の回へ持ち越すもの（受けた順） */
  carried: InstructionIntervention[];
  notes: BudgetNote[];
};

/**
 * 未反映の口出しのうち、次の「考える」に載せるものを上限の内で決める。
 */
export function planInterventions(
  interventions: readonly InterventionRecord[],
  limits: InterventionLimits,
): InterventionPlan {
  // 1件の上限を合計の上限で頭打ちにする: 先頭の1件が合計に入らないと、以後ずっと持ち越されて反映されないため
  const textEach = Math.min(limits.textEach, limits.maxSize);
  const clipped = pendingInterventions(interventions).map((intervention) => ({
    intervention,
    clipped: clipText(intervention.text, textEach),
  }));
  const packed = packWithinBudget(clipped, {
    size: (c) => [...c.clipped.text].length,
    limits: { maxCount: limits.maxCount, maxSize: limits.maxSize },
  });
  // 入らなかった1件の後ろにある小さいものを先に載せない: 後の指示だけが先に反映され、指示の順序が入れ替わるため
  const firstDropped = packed.dropped[0];
  const cut = firstDropped === undefined ? clipped.length : clipped.indexOf(firstDropped.item);
  const included = clipped.slice(0, cut);
  const carried = clipped.slice(cut).map((c) => c.intervention);

  const notes: BudgetNote[] = [];
  for (const { intervention, clipped: c } of included) {
    if (c.clippedFrom !== undefined) {
      notes.push({
        kind: 'clipped',
        section: `interventions.${intervention.interventionId}`,
        from: c.clippedFrom,
        to: textEach,
      });
    }
  }
  for (const intervention of carried) {
    notes.push({
      kind: 'dropped',
      section: `interventions.${intervention.interventionId}`,
      reason: '口出しの上限に入らないので次の回へ持ち越す',
    });
  }
  return {
    included: included.map(({ intervention, clipped: c }) => ({
      interventionId: intervention.interventionId,
      text: c.text,
    })),
    carried,
    notes,
  };
}
