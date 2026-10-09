import type { LlmCallRecord } from '@drawroid/core';
import { Hono } from 'hono';

import type { ApiDeps } from '../deps.js';
import { invalidFile, invalidRequest, notFound } from '../errors.js';

type Totals = {
  calls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
};

// 1つでも null なら null: 数えられなかった呼び出しを 0 として足すと、少なく見えて減らす対象を見誤るため
function sumOrNull(values: (number | null)[]): number | null {
  if (values.includes(null)) return null;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function totalOf(records: LlmCallRecord[]): Totals {
  return {
    calls: records.length,
    inputTokens: sumOrNull(records.map((r) => r.usage.inputTokens)),
    outputTokens: sumOrNull(records.map((r) => r.usage.outputTokens)),
    durationMs: records.reduce((sum, r) => sum + r.durationMs, 0),
  };
}

function byIteration(records: LlmCallRecord[]) {
  const groups = new Map<number | null, LlmCallRecord[]>();
  for (const record of records) {
    groups.set(record.iteration, [...(groups.get(record.iteration) ?? []), record]);
  }
  return [...groups]
    .sort(([a], [b]) => (a ?? Infinity) - (b ?? Infinity))
    .map(([iteration, group]) => ({ iteration, ...totalOf(group) }));
}

// 中身（input・outcome の value）を入れない: 一覧は数を見る画面で、全呼び出しの入力を毎回運ぶと重いため。読むときは /:callId
function summaryOf(r: LlmCallRecord) {
  return {
    callId: r.callId,
    iteration: r.iteration,
    role: r.role,
    purpose: r.purpose,
    provider: r.provider,
    model: r.model,
    startedAt: r.startedAt,
    durationMs: r.durationMs,
    usage: r.usage,
    ok: r.outcome.ok,
    attempts: r.attempts.length,
  };
}

export function llmCallsRoutes({ store }: ApiDeps) {
  return new Hono()
    .get('/', async (c) => {
      const jobId = c.req.param('jobId') ?? '';
      const iterationQuery = c.req.query('iteration');
      if (iterationQuery !== undefined && !/^[1-9]\d*$/.test(iterationQuery)) {
        return invalidRequest(c, 'iteration は 1 以上の整数');
      }
      if (!(await store.listJobIds()).includes(jobId)) return notFound(c, `ジョブ ${jobId} は無い`);
      const { records, invalid } = await store.listLlmCallRecords(jobId);
      const selected =
        iterationQuery === undefined
          ? records
          : records.filter((r) => r.iteration === Number(iterationQuery));
      const calls = selected.map(summaryOf);
      return c.json(
        { calls, byIteration: byIteration(selected), total: totalOf(selected), invalid },
        200,
      );
    })
    .get('/:callId', async (c) => {
      const jobId = c.req.param('jobId') ?? '';
      const callId = c.req.param('callId');
      if (!(await store.listJobIds()).includes(jobId)) return notFound(c, `ジョブ ${jobId} は無い`);
      // 一覧に在る callId だけを通す: 外から来た文字列でパスを組まないため
      const { records, invalid } = await store.listLlmCallRecords(jobId);
      const record = records.find((r) => r.callId === callId);
      if (record !== undefined) return c.json(record, 200);
      const broken = invalid.find((i) => i.callId === callId);
      if (broken !== undefined) return invalidFile(c, broken.reason);
      return notFound(c, `呼び出し ${callId} は無い`);
    });
}

/**
 * ジョブに属さない LLM 呼び出しの記録（データディレクトリ直下の llm-calls/。止める条件の変換など）。
 * PRD:140「全ての LLM 呼び出しについて…UI で見られる」のうち、ジョブの下に無いもの。
 */
export function unattachedLlmCallsRoutes({ store }: ApiDeps) {
  return new Hono()
    .get('/', async (c) => {
      const { records, invalid } = await store.listLlmCallRecords(null);
      // 新しい順: 直前に試した変換を、一覧の先頭で見られるように
      const calls = [...records].reverse().map(summaryOf);
      return c.json({ calls, total: totalOf(records), invalid }, 200);
    })
    .get('/:callId', async (c) => {
      const callId = c.req.param('callId');
      // 一覧に在る callId だけを通す: 外から来た文字列でパスを組まないため
      const { records, invalid } = await store.listLlmCallRecords(null);
      const record = records.find((r) => r.callId === callId);
      if (record !== undefined) return c.json(record, 200);
      const broken = invalid.find((i) => i.callId === callId);
      if (broken !== undefined) return invalidFile(c, broken.reason);
      return notFound(c, `呼び出し ${callId} は無い`);
    });
}
