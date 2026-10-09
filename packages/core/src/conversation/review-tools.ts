import { z } from 'zod';

import { resolveBudgets, type Budgets } from '../budget/settings.js';
import type { ImageRef, JobStore } from '../job/store.js';
import type { AutoJobSpec } from '../job/types.js';
import type { LlmPort } from '../llm/port.js';
import { toLlmCallRecord } from '../llm/record.js';
import { buildJudgeInput } from '../loop/inputs.js';
import { defaultCallId } from '../loop/runner.js';
import { buildJudgeOutputSchema, type JudgeOutput } from '../loop/schemas.js';
import type { MemoryStore } from '../memory/store.js';
import { formatImageKey } from '../selection/selection.js';
import { activeJobOfConversation } from './drawing-tools.js';
import { describeJudgement } from './drawing.js';
import type { TalkTool, TalkToolOutcome } from './talk/tools.js';

/** 見る役に評価させるツールが使うもの。cli で閉じ込めて渡す（createDrawingTools と同じ形） */
export type ReviewToolDeps = {
  jobs: Pick<
    JobStore,
    | 'listJobIds'
    | 'readJob'
    | 'readState'
    | 'readGeneration'
    | 'listGenerations'
    | 'readStage'
    | 'readAdopted'
    | 'listInterventions'
    | 'loadPreview'
    | 'markSent'
    | 'writeLlmCall'
    | 'listLlmCallRecords'
  >;
  /** いまの LLM（設定が無ければ undefined）。自動ジョブと同じ設定の見る役を使う */
  llm(): LlmPort | undefined;
  /** 予算を持たない古いジョブに使う予算。持つジョブは、そのジョブの予算でループと同じ入力を組む */
  budgets(): Promise<Budgets>;
  /** あれば、ループの見る役と同じ選び方・同じ予算で記憶を渡す */
  memory?: MemoryStore;
  newCallId?: (now: Date) => string;
  now?: () => Date;
};

const reviewInputSchema = z.object({
  jobId: z
    .string()
    .min(1)
    .optional()
    .describe('ジョブ。省けば、この会話で描いている（直近の）ジョブ'),
  iteration: z.number().int().positive().optional().describe('回。省けば最新の回'),
  index: z.number().int().nonnegative().optional().describe('その回の何枚目か（0 から）。省けば 0'),
});

function outcome(ok: boolean, text: string): TalkToolOutcome {
  return { ok, result: text, summary: text };
}

/**
 * 見る役を呼ぶツール。評価の言い回しは見る役の短い欄を describeJudgement で型どおりに文にするだけで、
 * 見る役に「人間向けの一言」の欄を足さない。
 */
export function createReviewTools(deps: ReviewToolDeps): TalkTool[] {
  const now = deps.now ?? (() => new Date());
  const newCallId = deps.newCallId ?? defaultCallId;

  async function pickJob(
    conversationId: string,
    jobId: string | undefined,
  ): Promise<{ spec: AutoJobSpec } | { problem: string }> {
    if (jobId !== undefined) {
      const spec = await deps.jobs.readJob(jobId).catch(() => undefined);
      if (spec?.kind !== 'auto' || spec.conversationId !== conversationId) {
        return { problem: `ジョブ ${jobId} はこの会話のジョブではない` };
      }
      return { spec };
    }
    const active = await activeJobOfConversation(deps.jobs, conversationId);
    if (active !== undefined) {
      const spec = await deps.jobs.readJob(active);
      if (spec.kind === 'auto') return { spec };
    }
    let latest: AutoJobSpec | undefined;
    for (const id of await deps.jobs.listJobIds()) {
      const spec = await deps.jobs.readJob(id);
      if (spec.kind === 'auto' && spec.conversationId === conversationId) latest = spec;
    }
    return latest === undefined ? { problem: 'この会話には、描いた絵が無い' } : { spec: latest };
  }

  const reviewImage: TalkTool = {
    name: 'review_image',
    description:
      '人間が「この絵どう？」と聞いたときに、その画像を見る役に評価させる（点数・問題点・次に変えること）。評価済みの画像は、呼び直さずにその評価を返す',
    inputSchema: reviewInputSchema,
    async run(raw, context) {
      const input = reviewInputSchema.parse(raw);
      const picked = await pickJob(context.conversationId, input.jobId);
      if ('problem' in picked) return outcome(false, picked.problem);
      const { spec } = picked;
      const { jobId } = spec;

      const generations = await deps.jobs.listGenerations(jobId);
      const iteration = input.iteration ?? generations.at(-1)?.iteration;
      if (iteration === undefined) return outcome(false, 'まだ画像が1枚もできていない');
      const index = input.index ?? 0;
      const key = formatImageKey({ iteration, index });
      const generation = await deps.jobs.readGeneration(jobId, iteration);
      if (generation === undefined || index >= generation.images.length) {
        return outcome(false, `画像 ${key} は無い（ジョブ ${jobId}）`);
      }
      const ref: ImageRef = { jobId, iteration, index };

      // 評価済み: ループの見る役の出力（judge.json）をそのまま文にする。呼ばない
      const judged = (await deps.jobs.readStage(jobId, iteration, 'judge')) as
        JudgeOutput | undefined;
      if (judged?.images[index] !== undefined) {
        return outcome(true, describeFor(iteration, index, judged, judged.images[index]));
      }

      // 評価がまだで、ループの見る役が受け持つ回は、二重に送らない
      const state = await deps.jobs.readState(jobId);
      if (state.status !== 'stopped' && !(await loopSkipsJudging(deps.jobs, jobId, iteration))) {
        return outcome(false, `画像 ${key} はまだ評価中（ジョブ ${jobId} の見る役が見ている）`);
      }
      const carry = state.carry;
      if (carry === undefined) return outcome(false, `ジョブ ${jobId} には評価に使う要約が無い`);

      const budget =
        spec.budgets === undefined ? await deps.budgets() : resolveBudgets(spec.budgets);
      const preview = await deps.jobs.loadPreview(ref, budget.imageLongEdge);

      // 渡し済み: その呼び出しの記録（LLM 呼び出しの記録）から、前の評価を返す。同じ画像を2回渡さない
      if (preview.sentInCall !== undefined) {
        return outcome(...(await earlierReview(deps.jobs, ref, preview.key, preview.sentInCall)));
      }

      const llm = deps.llm();
      if (llm === undefined) return outcome(false, 'LLM の設定が無く、見る役を呼べない');
      let memory;
      if (deps.memory !== undefined) {
        try {
          memory = { items: (await deps.memory.list()).items, limits: budget.memory.judge };
        } catch (error) {
          return outcome(
            false,
            `記憶を読めず、見る役を呼べない: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const messages = buildJudgeInput({
        carry,
        images: [preview],
        budget,
        window: llm.describe('judge').window,
        ...(memory !== undefined && { memory }),
      });
      const startedAt = now();
      const result = await llm.generateStructured({
        role: 'judge',
        purpose: 'judge',
        schema: buildJudgeOutputSchema(1),
        messages,
        signal: context.signal,
      });
      const callId = newCallId(startedAt);
      const { provider, model } = llm.describe('judge');
      await deps.jobs.writeLlmCall(
        toLlmCallRecord({
          callId,
          jobId,
          iteration,
          role: 'judge',
          purpose: 'judge',
          provider,
          model,
          startedAt,
          messages,
          outcome: result,
        }),
      );
      await deps.jobs.markSent(ref, callId, now());
      if (!result.ok) return outcome(false, `見る役が評価を返せなかった: ${result.reason}`);
      const only = result.value.images[0]!;
      return outcome(true, describeFor(iteration, index, result.value, only));
    },
  };

  return [reviewImage];
}

function describeFor(
  iteration: number,
  index: number,
  judged: Pick<JudgeOutput, 'nextChange' | 'canStop'>,
  image: JudgeOutput['images'][number],
): string {
  const sentence = describeJudgement({
    images: [{ index, score: image.score, issues: image.issues }],
    nextChange: judged.nextChange,
    canStop: judged.canStop,
  });
  return `回 ${iteration}: ${sentence}`;
}

/** 人間の選択で打ち切る回は、ループの見る役が呼ばない（adopted.json があるか、これから置かれる） */
async function loopSkipsJudging(
  jobs: Pick<JobStore, 'readAdopted' | 'listInterventions'>,
  jobId: string,
  iteration: number,
): Promise<boolean> {
  if ((await jobs.readAdopted(jobId, iteration)) !== undefined) return true;
  const chosen = (await jobs.listInterventions(jobId)).findLast((i) => i.kind === 'adopt');
  return chosen?.kind === 'adopt' && chosen.image.iteration === iteration;
}

async function earlierReview(
  jobs: Pick<JobStore, 'listLlmCallRecords'>,
  ref: ImageRef,
  imageKey: string,
  callId: string,
): Promise<[boolean, string]> {
  const key = formatImageKey(ref);
  const { records } = await jobs.listLlmCallRecords(ref.jobId);
  const call = records.find((record) => record.callId === callId);
  if (call === undefined) {
    return [false, `画像 ${key} は呼び出し ${callId} で渡し済みだが、その記録が読めない`];
  }
  if (!call.outcome.ok) {
    return [
      false,
      `画像 ${key} は呼び出し ${callId} で渡したが、評価を得られなかった: ${call.outcome.reason}`,
    ];
  }
  const sent = call.input.user.filter((part) => part.type === 'image');
  const position = sent.findIndex((part) => part.key === imageKey);
  const parsed = buildJudgeOutputSchema(sent.length).safeParse(call.outcome.value);
  const image = parsed.success ? parsed.data.images[position] : undefined;
  if (!parsed.success || image === undefined) {
    return [false, `画像 ${key} は呼び出し ${callId} で渡したが、記録の評価が読めない`];
  }
  return [true, describeFor(ref.iteration, ref.index, parsed.data, image)];
}
