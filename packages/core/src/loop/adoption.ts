import type { JobStore } from '../job/store.js';
import type { AdoptIntervention, AdoptedRecord, InterventionRecord } from '../job/types.js';

/** 人間の選択（adopt の口出し）のうち、最後のもの */
export function latestAdoption(
  interventions: readonly InterventionRecord[],
): AdoptIntervention | undefined {
  return interventions.findLast((i): i is AdoptIntervention => i.kind === 'adopt');
}

/** 人間の選択で打ち切る回の、その選択。記録済み（adopted.json）か、まだ書かれていない口出しか */
export type AdoptionCut =
  | { state: 'recorded'; record: AdoptedRecord }
  | { state: 'pending'; intervention: AdoptIntervention };

/** この回が人間の選択で打ち切られるなら、その選択。そうでなければ undefined */
export async function adoptionCutting(
  jobs: Pick<JobStore, 'readAdopted' | 'listInterventions'>,
  jobId: string,
  iteration: number,
): Promise<AdoptionCut | undefined> {
  const record = await jobs.readAdopted(jobId, iteration);
  if (record !== undefined) return { state: 'recorded', record };
  const chosen = latestAdoption(await jobs.listInterventions(jobId));
  if (chosen?.image.iteration !== iteration) return undefined;
  return { state: 'pending', intervention: chosen };
}
