import type { JobStore } from '../job/store.js';
import type { AutoJobSpec } from '../job/types.js';
import type { InterventionMaterial } from '../memory/distill/input.js';
import type { ConversationEvent, NewConversationEvent } from './events.js';
import type { ConversationHubs } from './hub.js';
import { jobEvents } from './job-bridge.js';
import type { ConversationStore } from './store.js';

/** 再起動で途切れたターンを閉じるときの理由 */
export const RESTART_REASON = 'プロセスの再起動で途切れた';

async function readAll(
  store: ConversationStore,
  conversationId: string,
): Promise<ConversationEvent[]> {
  const events: ConversationEvent[] = [];
  let after = 0;
  for (;;) {
    const page = await store.readEvents(conversationId, { after });
    events.push(...page.events);
    after = page.last;
    if (!page.more) return events;
  }
}

/**
 * 起動のときに、turn.started があって turn.ended が無いターンを interrupted で閉じる。閉じた数を返す。
 */
// 自動ではやり直さない: start_drawing が半分だけ走ったかもしれず、やり直すと二重に描き始めうるため（設計の推奨 8）。
// 人間は画面の「送り直す」で送り直す
export async function closeInterruptedTurns(deps: {
  store: ConversationStore;
  hubs: ConversationHubs;
}): Promise<number> {
  let closed = 0;
  for (const conversationId of await deps.store.listConversationIds()) {
    const open = new Set<number>();
    for (const event of await readAll(deps.store, conversationId)) {
      if (event.type === 'turn.started') open.add(event.turn);
      if (event.type === 'turn.ended') open.delete(event.turn);
    }
    for (const turn of [...open].sort((a, b) => a - b)) {
      await deps.hubs.get(conversationId).confirm({
        type: 'turn.ended',
        turn,
        outcome: 'interrupted',
        reason: RESTART_REASON,
      });
      closed++;
    }
  }
  return closed;
}

/** ジョブのイベントを見分ける鍵。同じ段のイベントを二重に書かないため */
function keyOf(event: ConversationEvent | NewConversationEvent): string | undefined {
  switch (event.type) {
    case 'job.started':
    case 'job.stopped':
      return event.type;
    case 'job.think':
    case 'job.images':
    case 'job.judge':
      return `${event.type}:${event.iteration}`;
    case 'job.intervention':
      return `${event.type}:${event.interventionId}`;
    default:
      return undefined;
  }
}

/** ジョブのファイルから、会話に出ているはずのイベントを、起きた順に組む */
async function expectedEvents(jobs: JobStore, spec: AutoJobSpec): Promise<NewConversationEvent[]> {
  const { jobId } = spec;
  const events: NewConversationEvent[] = [jobEvents.started(spec)];
  const interventions = await jobs.listInterventions(jobId);
  for (const iteration of await jobs.listIterations(jobId)) {
    // 取り込んだ口出しは、その回の「考える」の前に確定している（橋渡しと同じ順）
    for (const intervention of interventions) {
      if (intervention.kind === 'instruction' && intervention.appliedInIteration === iteration) {
        events.push(
          jobEvents.intervention(jobId, intervention.interventionId, intervention.kind, iteration),
        );
      }
    }
    const think = await jobs.readStage(jobId, iteration, 'think');
    if (think !== undefined) {
      events.push(
        jobEvents.think(jobId, iteration, think, await jobs.readStage(jobId, iteration, 'plan')),
      );
    }
    const generation = await jobs.readGeneration(jobId, iteration);
    if (generation !== undefined)
      events.push(jobEvents.images(jobId, iteration, generation.images));
    const judge = await jobs.readStage(jobId, iteration, 'judge');
    if (judge !== undefined) events.push(jobEvents.judge(jobId, iteration, judge));
  }
  const state = await jobs.readState(jobId);
  if (state.status === 'stopped') events.push(jobEvents.stopped(jobId, state.reason));
  return events;
}

/**
 * 起動のときに、会話に属するジョブの段のファイルはあるのに、会話のイベントが無いものを書き足す。書き足した数を返す。
 * 段を書けたあとイベントを書く前に落ちたときに、ログから段が抜けたままにしないため。ジョブのファイルが正で、イベントはその写し
 */
export async function backfillJobEvents(deps: {
  jobs: JobStore;
  conversations: ConversationStore;
  hubs: ConversationHubs;
}): Promise<number> {
  const byConversation = new Map<string, AutoJobSpec[]>();
  for (const jobId of await deps.jobs.listJobIds()) {
    const spec = await deps.jobs.readJob(jobId);
    if (spec.kind !== 'auto' || spec.conversationId === undefined) continue;
    if (!(await deps.conversations.hasConversation(spec.conversationId))) continue;
    byConversation.set(spec.conversationId, [
      ...(byConversation.get(spec.conversationId) ?? []),
      spec,
    ]);
  }
  let added = 0;
  for (const [conversationId, specs] of byConversation) {
    const present = new Set<string>();
    for (const event of await readAll(deps.conversations, conversationId)) {
      const key = 'jobId' in event ? keyOf(event) : undefined;
      if (key !== undefined && 'jobId' in event) present.add(`${event.jobId}/${key}`);
    }
    for (const spec of specs) {
      for (const event of await expectedEvents(deps.jobs, spec)) {
        const key = `${spec.jobId}/${keyOf(event)}`;
        if (present.has(key)) continue;
        await deps.hubs.get(conversationId).confirm(event);
        present.add(key);
        added++;
      }
    }
  }
  return added;
}

/**
 * 止まったジョブの蒸留の材料に足す、会話での人間の発言を返す関数を作る。
 * そのジョブを作ったターンで読んだ発言から、ジョブが止まるまでの人間の発言を、古い順に返す。
 */
// 会話の全部を渡さない: ジョブに関わらない前後の話を蒸留に混ぜないため。量は蒸留の予算（messages）で締める
export function conversationMessagesFor(
  store: ConversationStore,
): (spec: AutoJobSpec) => Promise<readonly InterventionMaterial[]> {
  return async (spec) => {
    if (spec.conversationId === undefined || spec.turn === undefined) return [];
    if (!(await store.hasConversation(spec.conversationId))) return [];
    const events = await readAll(store, spec.conversationId);
    const started = events.find((e) => e.type === 'turn.started' && e.turn === spec.turn);
    if (started === undefined || started.type !== 'turn.started') return [];
    const from = Math.min(started.seq, ...started.messageSeqs);
    const stopped = events.find((e) => e.type === 'job.stopped' && e.jobId === spec.jobId);
    const until = stopped?.seq ?? Number.POSITIVE_INFINITY;
    return events.flatMap((event) =>
      event.type === 'user.message' && event.seq >= from && event.seq <= until
        ? [{ id: String(event.seq), text: event.text }]
        : [],
    );
  };
}
