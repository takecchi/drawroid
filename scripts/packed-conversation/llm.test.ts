import { afterEach, describe, expect, it } from 'vitest';

import { startFakeLlm } from './llm.mjs';

type FakeLlm = Awaited<ReturnType<typeof startFakeLlm>>;

const tool = (name: string, parameters: object = { type: 'object', properties: {} }) => ({
  type: 'function',
  function: { name, description: name, parameters },
});

const toolVariant = (name: string) => ({
  type: 'object',
  properties: {
    kind: { const: 'tool' },
    name: { const: name },
    input: { type: 'object', properties: {} },
  },
  required: ['kind', 'name', 'input'],
});

const replyVariant = {
  type: 'object',
  properties: { kind: { const: 'reply' }, text: { type: 'string' } },
  required: ['kind', 'text'],
};

describe('fake LLM talk role', () => {
  let llm: FakeLlm | undefined;

  afterEach(async () => {
    await llm?.close();
    llm = undefined;
  });

  async function talk(body: Record<string, unknown>) {
    llm ??= await startFakeLlm({ stopAfterIterations: 1 });
    const response = await fetch(`${llm.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'talk-model',
        messages: [{ role: 'user', content: 'hello' }],
        ...body,
      }),
    });
    return (await response.json()) as {
      choices: {
        message: {
          content: string | null;
          tool_calls?: { function: { name: string; arguments: string } }[];
        };
      }[];
    };
  }

  const calledToolName = (result: Awaited<ReturnType<typeof talk>>) =>
    result.choices[0]?.message.tool_calls?.[0]?.function.name;

  const jsonStep = (result: Awaited<ReturnType<typeof talk>>) =>
    JSON.parse(result.choices[0]?.message.content ?? 'null') as { kind: string; name?: string };

  const schemaFormat = (variants: object[]) => ({
    type: 'json_schema',
    json_schema: { name: 'step', schema: { anyOf: variants } },
  });

  it('calls the offered tool when start_drawing is not offered', async () => {
    const result = await talk({ tools: [tool('ping')] });

    expect(calledToolName(result)).toBe('ping');
  });

  it('calls the first offered tool when start_drawing is not offered', async () => {
    const result = await talk({ tools: [tool('ping'), tool('other')] });

    expect(calledToolName(result)).toBe('ping');
  });

  it('calls start_drawing when it is offered, wherever it sits in the tool list', async () => {
    const result = await talk({ tools: [tool('ping'), tool('start_drawing')] });

    expect(calledToolName(result)).toBe('start_drawing');
  });

  it('fills the arguments of the offered tool from its own schema', async () => {
    const result = await talk({
      tools: [
        tool('ping', {
          type: 'object',
          properties: { note: { type: 'string' } },
          required: ['note'],
        }),
      ],
    });

    const args = JSON.parse(result.choices[0]?.message.tool_calls?.[0]?.function.arguments ?? '{}');
    expect(args).toEqual({ note: 'x' });
  });

  it('calls the queued tool in preference to the offered ones', async () => {
    llm = await startFakeLlm({ stopAfterIterations: 1 });
    llm.queueTalkTool('favorite', { id: 'a' });

    const result = await talk({ tools: [tool('start_drawing'), tool('favorite')] });

    expect(calledToolName(result)).toBe('favorite');
  });

  it('streams a call to the offered tool when start_drawing is not offered', async () => {
    llm = await startFakeLlm({ stopAfterIterations: 1 });
    const response = await fetch(`${llm.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'talk-model',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [tool('ping')],
      }),
    });

    const text = await response.text();
    expect(text).toContain('"name":"ping"');
    expect(text).not.toContain('start_drawing');
  });

  it('answers a structured output that offers only ping with a ping call', async () => {
    const result = await talk({
      response_format: schemaFormat([replyVariant, toolVariant('ping')]),
    });

    expect(jsonStep(result)).toMatchObject({ kind: 'tool', name: 'ping' });
  });

  it('answers a structured output that offers start_drawing with a start_drawing call', async () => {
    const result = await talk({
      response_format: schemaFormat([
        replyVariant,
        toolVariant('ping'),
        toolVariant('start_drawing'),
      ]),
    });

    expect(jsonStep(result)).toMatchObject({ kind: 'tool', name: 'start_drawing' });
  });
});
