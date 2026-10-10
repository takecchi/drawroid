// 手動の生成（ManualGenerationRunner）を人間が止める口を、本物のファイルの置き場所の上で見る試験。
// バックエンドは、試験が開けるまで生成を返さないスタブで、「走っている間」を時間に頼らずに作る
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ManualGenerationRunner, type JobState } from '@drawroid/core';
import { StubBackend } from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsJobStore } from './job-store.js';
import { GatedBackend } from './testing/hold-gates.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-manual-stop-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const request = { prompt: 'a cat', steps: 4, cfgScale: 7, width: 64, height: 64 };

function setup(backend: StubBackend) {
  const store = new FsJobStore(root);
  return { store, runner: new ManualGenerationRunner({ backend, store }) };
}

const reasonOf = (state: JobState) =>
  state.status === 'stopped' ? state.reason.kind : state.status;

describe('stopping a manual generation', () => {
  it('cuts the generation that is running and tells the backend to stop, as a human stop', async () => {
    const backend = new GatedBackend(true);
    const { store, runner } = setup(backend);
    const { jobId } = await runner.start(request);
    await backend.generated(1);

    await runner.stop(jobId);
    await runner.idle();

    expect(backend.generateSignals[0]!.aborted).toBe(true);
    expect(backend.interruptCount).toBe(1);
    expect(reasonOf(await store.readState(jobId))).toBe('human');
    expect(await store.listGenerations(jobId)).toEqual([]);
  });

  // 待っている生成を止めても、走っている別の生成には触れない: interrupt() はバックエンドの今の生成を止めるため
  it('stops a waiting generation before it reaches the backend, and leaves the running one alone', async () => {
    const backend = new GatedBackend(true);
    const { store, runner } = setup(backend);
    const first = await runner.start({ ...request, prompt: 'first' });
    await backend.generated(1);
    const second = await runner.start({ ...request, prompt: 'second' });

    await runner.stop(second.jobId);
    expect(reasonOf(await store.readState(second.jobId))).toBe('human');
    expect(backend.interruptCount).toBe(0);
    expect(backend.generateSignals[0]!.aborted).toBe(false);

    backend.openGenerate();
    await runner.idle();
    expect(reasonOf(await store.readState(first.jobId))).toBe('limit:iterations');
    expect(await store.listGenerations(first.jobId)).toHaveLength(1);
    expect(backend.requests.map((sent) => sent.prompt)).toEqual(['first']);
    expect(reasonOf(await store.readState(second.jobId))).toBe('human');
  });

  // 「止める」の二度押しや、別のタブからの止めでも、順番が来たときに走り出さない
  it('keeps a waiting generation stopped when it is stopped twice', async () => {
    const backend = new GatedBackend(true);
    const { store, runner } = setup(backend);
    const first = await runner.start({ ...request, prompt: 'first' });
    await backend.generated(1);
    const second = await runner.start({ ...request, prompt: 'second' });

    await runner.stop(second.jobId);
    await runner.stop(second.jobId);

    backend.openGenerate();
    await runner.idle();
    expect(reasonOf(await store.readState(first.jobId))).toBe('limit:iterations');
    expect(backend.requests.map((sent) => sent.prompt)).toEqual(['first']);
    expect(reasonOf(await store.readState(second.jobId))).toBe('human');
    expect(await store.listGenerations(second.jobId)).toEqual([]);
  });

  it('keeps a waiting generation stopped when it is stopped twice at once', async () => {
    const backend = new GatedBackend(true);
    const { store, runner } = setup(backend);
    await runner.start({ ...request, prompt: 'first' });
    await backend.generated(1);
    const second = await runner.start({ ...request, prompt: 'second' });

    await Promise.all([runner.stop(second.jobId), runner.stop(second.jobId)]);

    backend.openGenerate();
    await runner.idle();
    expect(backend.requests.map((sent) => sent.prompt)).toEqual(['first']);
    expect(reasonOf(await store.readState(second.jobId))).toBe('human');
  });

  it('does nothing to a generation that has already stopped', async () => {
    const backend = new StubBackend();
    const { store, runner } = setup(backend);
    const { jobId } = await runner.start(request);
    await runner.idle();
    const before = await store.readState(jobId);

    await runner.stop(jobId);

    expect(await store.readState(jobId)).toEqual(before);
    expect(backend.interruptCount).toBe(0);
  });
});
