import { describe, expect, it } from 'vitest';

import type { LlmCallRecord } from '../llm/record.js';
import { ScriptedLlm } from '../testing/scripted-llm.js';
import {
  buildStopParseInput,
  parseStopConditions,
  STOP_TEXT_LIMIT,
  type StopParseOutput,
} from './stop-parse.js';
import { InputOverBudgetError } from './inputs.js';

const none: StopParseOutput = {
  aiJudgement: false,
  maxIterations: null,
  maxImages: null,
  maxDurationMinutes: null,
  unparsed: [],
};

async function parse(text: string, output: unknown) {
  const llm = new ScriptedLlm({ 'stop-parse': () => output });
  const records: LlmCallRecord[] = [];
  const draft = await parseStopConditions({
    llm,
    text,
    signal: new AbortController().signal,
    now: () => new Date('2026-10-09T00:00:00Z'),
    newCallId: () => 'c1',
    record: async (r) => {
      records.push(r);
    },
  });
  return { draft, llm, records };
}

describe('parseStopConditions', () => {
  it('turns the sentence into stop conditions, converting minutes to milliseconds', async () => {
    const { draft } = await parse('いい感じになったら止めて、最大30分', {
      ...none,
      aiJudgement: true,
      maxDurationMinutes: 30,
    });
    expect(draft).toEqual({
      ok: true,
      conditions: { aiJudgement: true, maxDurationMs: 1_800_000 },
      unparsed: [],
      warnings: [],
    });
  });

  it('leaves out the limits the sentence does not mention', async () => {
    const { draft } = await parse('10回まで', { ...none, maxIterations: 10 });
    expect(draft).toMatchObject({
      ok: true,
      conditions: { aiJudgement: false, maxIterations: 10 },
    });
    expect(draft.ok && Object.keys(draft.conditions)).toEqual(['aiJudgement', 'maxIterations']);
  });

  it('returns a draft that would never stop, with a warning instead of refusing it', async () => {
    const { draft } = await parse('ずっと回して', { ...none, unparsed: ['ずっと回して'] });
    expect(draft).toMatchObject({
      ok: true,
      conditions: { aiJudgement: false },
      unparsed: ['ずっと回して'],
      warnings: [{ kind: 'never-stops' }],
    });
  });

  it('shows the parts it could not express so the human can fix them', async () => {
    const { draft } = await parse('5枚まで。空が暗くなったら止めて', {
      ...none,
      maxImages: 5,
      unparsed: ['空が暗くなったら止めて'],
    });
    expect(draft).toMatchObject({ ok: true, unparsed: ['空が暗くなったら止めて'], warnings: [] });
  });

  it('fails with the reason when the model output does not fit the schema', async () => {
    const { draft } = await parse('10回まで', { ...none, maxIterations: -3 });
    expect(draft).toMatchObject({ ok: false });
  });

  it('records the call as one that belongs to no job', async () => {
    const { records } = await parse('10回まで', { ...none, maxIterations: 10 });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      callId: 'c1',
      jobId: null,
      iteration: null,
      role: 'think',
      purpose: 'stop-parse',
      outcome: { ok: true },
    });
    expect(records[0]?.usage.inputTokens).not.toBeNull();
  });

  it('records the call even when the output is rejected', async () => {
    const { records } = await parse('10回まで', { nonsense: true });
    expect(records[0]?.outcome).toMatchObject({ ok: false });
  });

  it('clips a long sentence to the limit, notes it, and tells the human', async () => {
    const long = 'あ'.repeat(STOP_TEXT_LIMIT + 50);
    const { draft, llm, records } = await parse(long, { ...none, maxIterations: 3 });
    const sent = llm.calls[0]?.messages.user[0];
    expect(sent?.type === 'text' && [...sent.text].length).toBeLessThanOrEqual(
      STOP_TEXT_LIMIT + 10,
    );
    expect(records[0]?.budget.notes).toEqual([
      { kind: 'clipped', section: 'stopText', from: STOP_TEXT_LIMIT + 50, to: STOP_TEXT_LIMIT },
    ]);
    expect(draft).toMatchObject({ ok: true, clippedFrom: STOP_TEXT_LIMIT + 50 });
  });

  it('does not call the model for an empty sentence', async () => {
    const { draft, llm, records } = await parse('   ', none);
    expect(draft).toMatchObject({ ok: false });
    expect(llm.calls).toEqual([]);
    expect(records).toEqual([]);
  });
});

// #68 の P7: 止める条件の文が窓に入らないときは、呼び出す前に断る
describe('buildStopParseInput', () => {
  it('refuses before calling the LLM when the input does not fit in the window', () => {
    expect(() =>
      buildStopParseInput('10 回まで。良くなったら止めてよい', {
        contextTokens: 120,
        maxOutputTokens: 100,
      }),
    ).toThrow(InputOverBudgetError);
  });

  it('builds the input when it fits', () => {
    const messages = buildStopParseInput('10 回まで', {
      contextTokens: 8192,
      maxOutputTokens: 1024,
    });
    expect(messages.report.estimatedInputTokens).toBeLessThanOrEqual(
      messages.report.inputTokenLimit,
    );
  });
});
