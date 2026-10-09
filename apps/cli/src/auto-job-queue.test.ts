import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_BUDGET, type JobState, type LlmPort } from '@drawroid/core';
import { ScriptedLlm, StubBackend, type Script } from '@drawroid/core/testing';
import { llmConfigSchema, createLlm, type LlmConfig } from '@drawroid/llm';
import { FsJobStore } from '@drawroid/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AutoJobQueue } from './auto-job-queue.js';

let root: string;
let store: FsJobStore;
let logs: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-queue-'));
  store = new FsJobStore(root);
  logs = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const think: Script = (_call, n) => ({
  params: { prompt: `girl, take ${n + 1}`, negativePrompt: 'lowres', seed: -1, steps: 20, cfg: 7 },
  rationale: 'next',
});
const judge: Script = (call) => ({
  images: call.messages.user
    .filter((part) => part.type === 'image')
    .map(() => ({ score: 0.5, issues: [] })),
  nextChange: 'brighter',
  canStop: false,
});

const config: LlmConfig = llmConfigSchema.parse({
  providers: { cloud: { type: 'anthropic', apiKeyEnv: 'TEST_KEY' } },
  roles: { think: { provider: 'cloud', model: 'm' } },
});

function makeQueue(options: { backend?: StubBackend; env?: Record<string, string> }) {
  const llm = new ScriptedLlm({ think, judge });
  const queue = new AutoJobQueue({
    store,
    backend: options.backend ?? new StubBackend(),
    env: options.env ?? { TEST_KEY: 'sk-should-not-leak' },
    budget: DEFAULT_BUDGET,
    createLlm: (c, env) => (env['TEST_KEY'] ? llm : createLlm(c, { env })),
    log: (line) => logs.push(line),
  });
  return { queue, llm };
}

async function submit(maxIterations = 2) {
  return store.createJob(
    {
      kind: 'auto',
      request: '夕暮れの海辺の少女',
      stopConditions: { aiJudgement: false, maxIterations },
      batchSize: 1,
    },
    {
      status: 'queued',
      carry: { intent: '夕暮れの海辺の少女', completedIterations: 0 },
    },
    new Date(),
  );
}

const stateOf = (jobId: string): Promise<JobState> => store.readState(jobId);

describe('AutoJobQueue', () => {
  it('keeps a job queued while the LLM is not configured, then runs it once configured', async () => {
    const backend = new StubBackend();
    const { queue } = makeQueue({ backend });
    const spec = await submit();

    queue.kick();
    await queue.idle();
    expect((await stateOf(spec.jobId)).status).toBe('queued');
    expect(backend.requests).toEqual([]);

    queue.configure(config);
    queue.kick();
    await queue.idle();
    const state = await stateOf(spec.jobId);
    expect(state).toMatchObject({ status: 'stopped', reason: { kind: 'limit:iterations' } });
    expect(backend.requests).toHaveLength(2);
  });

  it('stops a waiting job as a human stop', async () => {
    const { queue } = makeQueue({});
    const spec = await submit();

    await queue.stop(spec.jobId);

    expect(await stateOf(spec.jobId)).toMatchObject({
      status: 'stopped',
      reason: { kind: 'human' },
    });
  });

  it('stays unconfigured and logs the variable name but not its value when the LLM cannot be built', async () => {
    const backend = new StubBackend();
    const { queue } = makeQueue({ backend, env: { TEST_KEY: '', OTHER: 'sk-should-not-leak' } });
    const spec = await submit();

    queue.configure(config);
    queue.kick();
    await queue.idle();

    expect((await stateOf(spec.jobId)).status).toBe('queued');
    const text = logs.join('\n');
    expect(text).toContain('TEST_KEY');
    expect(text).not.toContain('sk-should-not-leak');
  });

  it('applies a changed configuration from the next LLM call without rebuilding the runner', async () => {
    const first = new ScriptedLlm({ think, judge });
    const second = new ScriptedLlm({ think, judge });
    const made: LlmPort[] = [first, second];
    const queue = new AutoJobQueue({
      store,
      backend: new StubBackend(),
      env: {},
      budget: DEFAULT_BUDGET,
      createLlm: () => made.shift() ?? first,
      log: (line) => logs.push(line),
    });
    queue.configure(config);
    const a = await submit(1);
    queue.kick();
    await queue.idle();
    queue.configure(config);
    const b = await submit(1);
    queue.kick();
    await queue.idle();

    expect((await stateOf(a.jobId)).status).toBe('stopped');
    expect((await stateOf(b.jobId)).status).toBe('stopped');
    expect(first.calls.length).toBeGreaterThan(0);
    expect(second.calls.length).toBeGreaterThan(0);
  });
});
