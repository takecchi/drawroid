import { z } from 'zod';

import type { GenerationRequest, GenerationResult } from '../backend.js';
import type { JobStore, NewJobSpec, StageName } from '../job/store.js';
import type { JobState } from '../job/types.js';
import { iterationPlanSchema } from '../think/excluded.js';
import type { NewConversationEvent } from './events.js';
import type { ConversationHubs } from './hub.js';

const thinkStageSchema = z.object({
  params: z.record(z.string(), z.unknown()),
  rationale: z.string(),
  /** 考える役が自分で出した思考（あれば）。ジョブの実行器が段の出力に残す */
  reasoning: z.string().optional(),
});

const judgeStageSchema = z.object({
  images: z.array(z.object({ score: z.number(), issues: z.array(z.string()) })),
  nextChange: z.string(),
  canStop: z.boolean(),
  reasoning: z.string().optional(),
});

/**
 * ジョブの置き場所を包み、会話に属するジョブの段が書けたら、その会話のイベント（job.*）を確定する。
 * 包んだ置き場所をジョブ実行器に渡すと、実行器に手を入れずに、ジョブの各段が会話のログに出る。
 */
// 書けたあとに確定する: ジョブのファイルが正で、会話のイベントはその写しのため。
// イベントが書けなくてもジョブは止めない（onError に渡す）: 写しの失敗で、絵の試行錯誤を止めないため
export function bridgeJobEvents(
  inner: JobStore,
  deps: { hubs: ConversationHubs; onError?: (error: unknown) => void },
): JobStore {
  const conversations = new Map<string, string | null>();

  async function conversationOf(jobId: string): Promise<string | undefined> {
    let conversationId = conversations.get(jobId);
    if (conversationId === undefined) {
      const spec = await inner.readJob(jobId);
      conversationId = spec.kind === 'auto' ? (spec.conversationId ?? null) : null;
      conversations.set(jobId, conversationId);
    }
    return conversationId ?? undefined;
  }

  async function emit(jobId: string, event: () => Promise<NewConversationEvent | undefined>) {
    try {
      const conversationId = await conversationOf(jobId);
      if (conversationId === undefined) return;
      const built = await event();
      if (built !== undefined) await deps.hubs.get(conversationId).confirm(built);
    } catch (error) {
      deps.onError?.(error);
    }
  }

  const overrides: Partial<JobStore> = {
    async createJob(spec: NewJobSpec, state: JobState, now: Date, references = []) {
      const created = await inner.createJob(spec, state, now, references);
      if (created.kind === 'auto') {
        conversations.set(created.jobId, created.conversationId ?? null);
        await emit(created.jobId, async () => ({
          type: 'job.started',
          jobId: created.jobId,
          request: created.request,
          stopConditions: created.stopConditions,
          ...(created.permissions !== undefined && { permissions: created.permissions }),
        }));
      }
      return created;
    },

    async writeStage(jobId: string, iteration: number, stage: StageName, value: unknown) {
      await inner.writeStage(jobId, iteration, stage, value);
      if (stage === 'think') {
        await emit(jobId, async () => {
          const think = thinkStageSchema.parse(value);
          const plan = iterationPlanSchema.safeParse(
            await inner.readStage(jobId, iteration, 'plan'),
          );
          return {
            type: 'job.think',
            jobId,
            iteration,
            rationale: think.rationale,
            params: think.params,
            excluded: plan.success ? plan.data.excluded : [],
            ...(think.reasoning === undefined ? {} : { reasoning: think.reasoning }),
          };
        });
      }
      if (stage === 'judge') {
        await emit(jobId, async () => {
          const judge = judgeStageSchema.parse(value);
          return {
            type: 'job.judge',
            jobId,
            iteration,
            images: judge.images.map((image, index) => ({ index, ...image })),
            nextChange: judge.nextChange,
            canStop: judge.canStop,
            ...(judge.reasoning === undefined ? {} : { reasoning: judge.reasoning }),
          };
        });
      }
    },

    async writeGeneration(
      jobId: string,
      iteration: number,
      request: GenerationRequest,
      result: GenerationResult,
    ) {
      await inner.writeGeneration(jobId, iteration, request, result);
      await emit(jobId, async () => ({
        type: 'job.images',
        jobId,
        iteration,
        images: result.images.map((image, index) => ({ index, seed: image.seed })),
      }));
    },

    async markInterventionApplied(jobId: string, interventionId: string, iteration: number) {
      await inner.markInterventionApplied(jobId, interventionId, iteration);
      await emit(jobId, async () => {
        const taken = (await inner.listInterventions(jobId)).find(
          (intervention) => intervention.interventionId === interventionId,
        );
        if (taken === undefined) return undefined;
        return {
          type: 'job.intervention',
          jobId,
          interventionId,
          kind: taken.kind,
          iteration,
        };
      });
    },

    async writeState(jobId: string, state: JobState) {
      await inner.writeState(jobId, state);
      if (state.status === 'stopped') {
        await emit(jobId, async () => ({ type: 'job.stopped', jobId, reason: state.reason }));
      }
    },
  };

  // 包むのは上の書き込みだけ。ほかの口はそのまま中の置き場所へ渡す
  return new Proxy(inner, {
    get(target, property, receiver) {
      const own = overrides[property as keyof JobStore];
      if (own !== undefined) return own;
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/** ジョブの段の思考の増分を流す部品の ID。job.think / job.judge が確定したら、ハブはこの写しを捨てる */
export function jobReasoningPartId(
  jobId: string,
  iteration: number,
  role: 'think' | 'judge',
): string {
  return `job:${jobId}:${iteration}:${role}`;
}

/**
 * ジョブの実行器の onReasoning に渡す。会話に属するジョブの、考える役・見る役の思考の増分を、その会話へ流す
 * （delta.reasoning。ファイルには書かない。確定した思考は job.think / job.judge に載る）。
 */
export function relayJobReasoning(deps: {
  store: JobStore;
  hubs: ConversationHubs;
  onError?: (error: unknown) => void;
}): (event: { jobId: string; iteration: number; role: 'think' | 'judge'; text: string }) => void {
  const conversations = new Map<string, Promise<string | undefined>>();
  const conversationOf = (jobId: string) => {
    let found = conversations.get(jobId);
    if (found === undefined) {
      found = deps.store
        .readJob(jobId)
        .then((spec) => (spec.kind === 'auto' ? spec.conversationId : undefined));
      conversations.set(jobId, found);
    }
    return found;
  };
  // 届いた順に流す: 会話を引く間に次の増分が来ても、順が入れ替わらないように
  let chain: Promise<void> = Promise.resolve();
  return (event) => {
    chain = chain
      .then(async () => {
        const conversationId = await conversationOf(event.jobId);
        if (conversationId === undefined) return;
        deps.hubs.get(conversationId).live({
          type: 'delta.reasoning',
          partId: jobReasoningPartId(event.jobId, event.iteration, event.role),
          source: { role: event.role, jobId: event.jobId, iteration: event.iteration },
          text: event.text,
        });
      })
      .catch((error: unknown) => deps.onError?.(error));
  };
}
