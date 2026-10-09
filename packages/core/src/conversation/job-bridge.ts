import { z } from 'zod';

import type { GenerationRequest, GenerationResult } from '../backend.js';
import type { JobStore, NewJobSpec, StageName } from '../job/store.js';
import type { AutoJobSpec, JobState, StopReason } from '../job/types.js';
import { iterationPlanSchema } from '../think/excluded.js';
import type { NewConversationEvent } from './events.js';
import type { ConversationHubs } from './hub.js';

const thinkStageSchema = z.object({
  params: z.record(z.string(), z.unknown()),
  rationale: z.string(),
});

const judgeStageSchema = z.object({
  images: z.array(z.object({ score: z.number(), issues: z.array(z.string()) })),
  nextChange: z.string(),
  canStop: z.boolean(),
});

/**
 * ジョブの段の中身から、会話のイベントを組む。橋渡しと起動時の書き足しで、同じ形のイベントにするため
 */
export const jobEvents = {
  started(spec: AutoJobSpec): NewConversationEvent {
    return {
      type: 'job.started',
      jobId: spec.jobId,
      request: spec.request,
      stopConditions: spec.stopConditions,
      ...(spec.permissions !== undefined && { permissions: spec.permissions }),
    };
  },
  think(jobId: string, iteration: number, value: unknown, plan: unknown): NewConversationEvent {
    const think = thinkStageSchema.parse(value);
    const parsedPlan = iterationPlanSchema.safeParse(plan);
    return {
      type: 'job.think',
      jobId,
      iteration,
      rationale: think.rationale,
      params: think.params,
      excluded: parsedPlan.success ? parsedPlan.data.excluded : [],
    };
  },
  images(
    jobId: string,
    iteration: number,
    images: readonly { seed: number | null }[],
  ): NewConversationEvent {
    return {
      type: 'job.images',
      jobId,
      iteration,
      images: images.map((image, index) => ({ index, seed: image.seed })),
    };
  },
  judge(jobId: string, iteration: number, value: unknown): NewConversationEvent {
    const judge = judgeStageSchema.parse(value);
    return {
      type: 'job.judge',
      jobId,
      iteration,
      images: judge.images.map((image, index) => ({ index, ...image })),
      nextChange: judge.nextChange,
      canStop: judge.canStop,
    };
  },
  intervention(
    jobId: string,
    interventionId: string,
    kind: string,
    iteration: number,
  ): NewConversationEvent {
    return { type: 'job.intervention', jobId, interventionId, kind, iteration };
  },
  stopped(jobId: string, reason: StopReason): NewConversationEvent {
    return { type: 'job.stopped', jobId, reason };
  },
};

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
        await emit(created.jobId, async () => jobEvents.started(created));
      }
      return created;
    },

    async writeStage(jobId: string, iteration: number, stage: StageName, value: unknown) {
      await inner.writeStage(jobId, iteration, stage, value);
      if (stage === 'think') {
        await emit(jobId, async () =>
          jobEvents.think(jobId, iteration, value, await inner.readStage(jobId, iteration, 'plan')),
        );
      }
      if (stage === 'judge') {
        await emit(jobId, async () => jobEvents.judge(jobId, iteration, value));
      }
    },

    async writeGeneration(
      jobId: string,
      iteration: number,
      request: GenerationRequest,
      result: GenerationResult,
    ) {
      await inner.writeGeneration(jobId, iteration, request, result);
      await emit(jobId, async () => jobEvents.images(jobId, iteration, result.images));
    },

    async markInterventionApplied(jobId: string, interventionId: string, iteration: number) {
      await inner.markInterventionApplied(jobId, interventionId, iteration);
      await emit(jobId, async () => {
        const taken = (await inner.listInterventions(jobId)).find(
          (intervention) => intervention.interventionId === interventionId,
        );
        if (taken === undefined) return undefined;
        return jobEvents.intervention(jobId, interventionId, taken.kind, iteration);
      });
    },

    async writeState(jobId: string, state: JobState) {
      await inner.writeState(jobId, state);
      if (state.status === 'stopped') {
        await emit(jobId, async () => jobEvents.stopped(jobId, state.reason));
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
