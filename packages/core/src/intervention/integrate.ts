import { clipText } from '../budget/estimate.js';
import type { Budget } from '../loop/budget.js';
import type { Carry } from '../loop/carry.js';
import type { ThinkOutput } from '../loop/schemas.js';
import type { Intervention } from './intervention.js';
import type { InterventionPlan } from './plan.js';

export class InterventionNotIntegratedError extends Error {
  constructor(iteration: number) {
    super(`${iteration} 回目の「考える」は口出しを載せたのに、統合した依頼の要点を返していない`);
    this.name = 'InterventionNotIntegratedError';
  }
}

/**
 * 「考える」の結果を受けて、載せた口出しを依頼の要点へ統合し、取り込んだ回を書き戻す。
 * 持ち越した口出しは未反映のまま残す。
 */
// 口出しの原文を carry に足さない: 次の回から原文が積み増しで入力に載り、口出しの回数に比例して膨らむため
export function integrateInterventions(args: {
  carry: Carry;
  interventions: readonly Intervention[];
  plan: InterventionPlan;
  output: ThinkOutput;
  iteration: number;
  budget: Budget;
}): { carry: Carry; interventions: Intervention[] } {
  const { carry, interventions, plan, output, iteration, budget } = args;
  if (plan.included.length === 0) return { carry, interventions: [...interventions] };
  if (output.intent === undefined) throw new InterventionNotIntegratedError(iteration);

  const applied = new Set(plan.included.map((planned) => planned.id));
  return {
    carry: { ...carry, intent: clipText(output.intent, budget.text.intent).text },
    interventions: interventions.map((intervention) =>
      applied.has(intervention.id)
        ? { ...intervention, appliedInIteration: iteration }
        : intervention,
    ),
  };
}
