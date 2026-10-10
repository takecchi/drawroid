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

function setup(backend: StubBackend, log?: (line: string) => void) {
  const store = new FsJobStore(root);
  return {
    store,
    runner: new ManualGenerationRunner({ backend, store, ...(log !== undefined && { log }) }),
  };
}

/** 止めるよう言われると、数えたうえで失敗するバックエンド（落ちかけの Forge など） */
class FailingInterruptBackend extends GatedBackend {
  override async interrupt(): Promise<void> {
    await super.interrupt();
    throw new Error('中断の口が 500 を返した');
  }
}

const reasonOf = (state: JobState) =>
  state.status === 'stopped' ? state.reason.kind : state.status;

describe('stopping a manual generation', () => {
  it('cuts the generation that is running and tells the backend to stop, as a human stop', async () => {
    const backend = new GatedBackend(true);
    const lines: string[] = [];
    const { store, runner } = setup(backend, (line) => lines.push(line));
    const { jobId } = await runner.start(request);
    await backend.generated(1);

    await runner.stop(jobId);
    await runner.idle();

    expect(backend.generateSignals[0]!.aborted).toBe(true);
    expect(backend.interruptCount).toBe(1);
    expect(lines).toEqual([]);
    expect(reasonOf(await store.readState(jobId))).toBe('human');
    expect(await store.listGenerations(jobId)).toEqual([]);
  });

  // バックエンドが止めるのに失敗しても、生成の待ちはもう切ってあるので、人間の停止として終える。理由はログに残す
  it('ends as a human stop and logs why, even when the backend fails to stop', async () => {
    const backend = new FailingInterruptBackend(true);
    const lines: string[] = [];
    const { store, runner } = setup(backend, (line) => lines.push(line));
    const { jobId } = await runner.start(request);
    await backend.generated(1);

    await expect(runner.stop(jobId)).resolves.toBeUndefined();
    await runner.idle();

    expect(backend.interruptCount).toBe(1);
    expect(reasonOf(await store.readState(jobId))).toBe('human');
    expect(lines).toEqual([expect.stringContaining('中断の口が 500 を返した')]);
    expect(lines[0]).toContain(jobId);
  });

  // 「止める」の二度押し: 走っている生成を止めるよう、バックエンドに言うのは1回だけ
  it('tells the backend to stop only once when the running generation is stopped twice at once', async () => {
    const backend = new GatedBackend(true);
    const { store, runner } = setup(backend);
    const { jobId } = await runner.start(request);
    await backend.generated(1);

    await Promise.all([runner.stop(jobId), runner.stop(jobId)]);
    await runner.idle();

    expect(backend.interruptCount).toBe(1);
    expect(reasonOf(await store.readState(jobId))).toBe('human');
  });

  // 1回だけにそろえるのは同じ生成の中だけ: あとから走った生成を止めれば、またバックエンドに止めさせる
  it('tells the backend to stop again for a later generation', async () => {
    const backend = new GatedBackend(true);
    const { store, runner } = setup(backend);
    const first = await runner.start({ ...request, prompt: 'first' });
    const second = await runner.start({ ...request, prompt: 'second' });
    await backend.generated(1);
    await runner.stop(first.jobId);
    await backend.generated(2);

    await runner.stop(second.jobId);
    await runner.idle();

    expect(backend.interruptCount).toBe(2);
    expect(backend.generateSignals[1]!.aborted).toBe(true);
    expect(reasonOf(await store.readState(second.jobId))).toBe('human');
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
