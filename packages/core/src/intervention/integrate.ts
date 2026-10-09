import { clipText } from '../budget/estimate.js';
import type { Budget } from '../loop/budget.js';
import type { Carry } from '../loop/carry.js';
import type { ThinkOutput } from '../loop/schemas.js';
import type { InterventionRecord } from '../job/types.js';
import type { InterventionPlan } from './plan.js';

export class InterventionNotIntegratedError extends Error {
  constructor(iteration: number) {
    super(`${iteration} 回目の「考える」は口出しを載せたのに、統合した依頼の要点を返していない`);
    this.name = 'InterventionNotIntegratedError';
  }
}

/** 考える役が統合した依頼の要点を返していれば、carry の要点をそれに置き換える */
export function applyIntegratedIntent(carry: Carry, output: ThinkOutput, budget: Budget): Carry {
  if (output.intent === undefined) return carry;
  return { ...carry, intent: clipText(output.intent, budget.text.intent).text };
}

/**
 * 「考える」の結果を受けて、載せた口出しを依頼の要点へ統合し、取り込んだ回を書き戻す。
 * 持ち越した口出しは未反映のまま残す。
 */
// 口出しの原文を carry に足さない: 次の回から原文が積み増しで入力に載り、口出しの回数に比例して膨らむため
export function integrateInterventions(args: {
  carry: Carry;
  interventions: readonly InterventionRecord[];
  plan: InterventionPlan;
  output: ThinkOutput;
  iteration: number;
  budget: Budget;
}): { carry: Carry; interventions: InterventionRecord[] } {
  const { carry, interventions, plan, output, iteration, budget } = args;
  if (plan.included.length === 0) return { carry, interventions: [...interventions] };
  if (output.intent === undefined) throw new InterventionNotIntegratedError(iteration);

  const applied = new Set(plan.included.map((planned) => planned.interventionId));
  return {
    carry: applyIntegratedIntent(carry, output, budget),
    interventions: interventions.map((intervention) =>
      intervention.kind === 'instruction' && applied.has(intervention.interventionId)
        ? { ...intervention, appliedInIteration: iteration }
        : intervention,
    ),
  };
}
