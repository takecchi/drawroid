import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LlmNotConfiguredError } from '@drawroid/api';
import { DEFAULT_BUDGET } from '@drawroid/core';
import { ScriptedLlm, StubBackend } from '@drawroid/core/testing';
import { llmConfigSchema } from '@drawroid/llm';
import { FsJobStore } from '@drawroid/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AutoJobQueue } from './auto-job-queue.js';
import { createStopConditionParser } from './stop-condition-parser.js';

let root: string;
let store: FsJobStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-stop-parser-'));
  store = new FsJobStore(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const config = llmConfigSchema.parse({
  providers: { cloud: { type: 'anthropic', apiKeyEnv: 'TEST_KEY' } },
  roles: { think: { provider: 'cloud', model: 'm' } },
});

function setup() {
  const llm = new ScriptedLlm({
    'stop-parse': () => ({
      aiJudgement: true,
      maxIterations: 5,
      maxImages: null,
      maxDurationMinutes: null,
      unparsed: [],
    }),
  });
  const queue = new AutoJobQueue({
    store,
    backend: new StubBackend(),
    env: { TEST_KEY: 'x' },
    budget: DEFAULT_BUDGET,
    createLlm: () => llm,
    log: () => undefined,
  });
  const parser = createStopConditionParser({ store, currentLlm: () => queue.currentLlm() });
  return { queue, parser };
}

describe('createStopConditionParser', () => {
  it('throws LlmNotConfiguredError while no LLM is configured', async () => {
    const { parser } = setup();
    await expect(parser.parse('5回', new AbortController().signal)).rejects.toBeInstanceOf(
      LlmNotConfiguredError,
    );
  });

  it('returns a draft and records the call without a job once the LLM is configured', async () => {
    const { queue, parser } = setup();
    queue.configure(config);

    const draft = await parser.parse('5回か、AI が良いと思ったら', new AbortController().signal);

    expect(draft).toMatchObject({
      ok: true,
      conditions: { aiJudgement: true, maxIterations: 5 },
    });
    const calls = await store.listLlmCalls(null);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ jobId: null, purpose: 'stop-parse' });
  });
});
