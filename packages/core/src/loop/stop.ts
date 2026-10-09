import type { JobStore } from '../job/store.js';
import type {
  AutoJobSpec,
  StopConditions,
  StopConditionsChange,
  StopReason,
} from '../job/types.js';

/** 今そのジョブに効いている止める条件。job.json の条件に、interventions/ の変更を受けた順に重ねる */
export async function readStopConditions(
  store: JobStore,
  spec: AutoJobSpec,
): Promise<StopConditions> {
  const interventions = await store.listInterventions(spec.jobId);
  return effectiveStopConditions(
    spec.stopConditions,
    interventions.flatMap((intervention) =>
      intervention.kind === 'stopConditions' ? [intervention.stopConditions] : [],
    ),
  );
}

/**
 * 実際に効いている止める条件。job.json の条件に、走行中の変更を受けた順に重ねる。
 */
export function effectiveStopConditions(
  base: StopConditions,
  changes: readonly StopConditionsChange[],
): StopConditions {
  const conditions: StopConditions = { ...base };
  for (const change of changes) {
    if (change.aiJudgement !== undefined) conditions.aiJudgement = change.aiJudgement;
    for (const key of ['maxIterations', 'maxDurationMs', 'maxImages'] as const) {
      const value = change[key];
      if (value === null) delete conditions[key];
      else if (value !== undefined) conditions[key] = value;
    }
  }
  return conditions;
}

/** AI の判断か、上限（回数・時間・枚数）のどれか1つ以上を持つか。持たないジョブは止まらない */
export function hasAnyStopCondition(conditions: StopConditions): boolean {
  return (
    conditions.aiJudgement ||
    conditions.maxIterations !== undefined ||
    conditions.maxDurationMs !== undefined ||
    conditions.maxImages !== undefined
  );
}

export type StopCheck = {
  conditions: StopConditions;
  completedIterations: number;
  imagesGenerated: number;
  elapsedMs: number;
  /** 直前の回の「見る」が「止めてよい」と言ったか。まだ回していなければ false */
  judgeSaysStop: boolean;
};

/**
 * 回の境目で、次の回へ進むかを決める。人間の停止とエラーはここを通らない（即座に止める）。
 * 順は AI の判断 → 回数 → 枚数 → 時間。
 */
export function checkStopAtBoundary(check: StopCheck): StopReason | undefined {
  const { conditions } = check;
  if (conditions.aiJudgement && check.judgeSaysStop) {
    return { kind: 'ai', detail: '見る役が意図どおりと判断した' };
  }
  if (
    conditions.maxIterations !== undefined &&
    check.completedIterations >= conditions.maxIterations
  ) {
    return { kind: 'limit:iterations', detail: `${conditions.maxIterations} 回に達した` };
  }
  if (conditions.maxImages !== undefined && check.imagesGenerated >= conditions.maxImages) {
    return { kind: 'limit:images', detail: `${conditions.maxImages} 枚に達した` };
  }
  if (conditions.maxDurationMs !== undefined && check.elapsedMs >= conditions.maxDurationMs) {
    return {
      kind: 'limit:duration',
      detail: `${Math.round(conditions.maxDurationMs / 1000)} 秒に達した`,
    };
  }
  return undefined;
}
