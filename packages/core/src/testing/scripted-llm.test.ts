import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { sealMessages, type TalkStepCall, type TalkStepPart } from '../llm/port.js';
import { ScriptedLlm, type TalkScript } from './scripted-llm.js';

const lookup = {
  name: 'search_candidates',
  description: '候補を調べる',
  inputSchema: z.object({ query: z.string().min(1) }),
};
const step = (signal = new AbortController().signal): TalkStepCall => ({
  role: 'think',
  messages: sealMessages('話す役', [{ type: 'text', text: '描けますか？' }], {
    estimatedInputTokens: 10,
    inputTokenLimit: 100,
    notes: [],
  }),
  tools: [lookup],
  signal,
});

async function partsOf(llm: ScriptedLlm, call: TalkStepCall): Promise<TalkStepPart[]> {
  const parts: TalkStepPart[] = [];
  for await (const part of llm.streamStep(call)) parts.push(part);
  return parts;
}

describe('ScriptedLlm.streamStep', () => {
  it('streams the scripted thinking, text and validated tool calls, then finishes', async () => {
    const talk: TalkScript = (_call, n) =>
      n === 0
        ? {
            reasoning: '調べる',
            toolCalls: [{ name: 'search_candidates', input: { query: 'miku' } }],
          }
        : { text: '描けます' };
    const llm = new ScriptedLlm({}, { talk });

    expect(await partsOf(llm, step())).toEqual([
      { type: 'reasoning-delta', text: '調べる' },
      {
        type: 'tool-call',
        callId: 'scripted-0-0',
        name: 'search_candidates',
        input: { query: 'miku' },
      },
      { type: 'finish', attempts: [expect.objectContaining({ durationMs: 1 })] },
    ]);
    expect((await partsOf(llm, step())).map((p) => p.type)).toEqual(['text-delta', 'finish']);
    expect(llm.steps).toHaveLength(2);
  });

  it('fails the step when a scripted tool call does not match the schema', async () => {
    const llm = new ScriptedLlm(
      {},
      { talk: () => ({ toolCalls: [{ name: 'search_candidates', input: { query: '' } }] }) },
    );
    const parts = await partsOf(llm, step());
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      type: 'finish',
      failure: expect.stringContaining('search_candidates'),
    });
  });

  it('throws when the step is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const llm = new ScriptedLlm({}, { talk: () => ({ text: 'x' }) });
    await expect(partsOf(llm, step(controller.signal))).rejects.toThrow();
  });
});
