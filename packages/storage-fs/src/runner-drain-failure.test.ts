// 待ち行列の走査（JobRunner の drain）が失敗しても、誰も受けない Promise にならず、プロセスを落とさず、
// 残りのジョブが回ることを見る試験。走査の最中にジョブのディレクトリが消える窓は、置き場所の一覧の読み出しを門で待たせて作る。
// 置き場所は本物のファイル、LLM は台本どおりのスタブ、バックエンドは M1 のスタブ
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  basicPermissions,
  DEFAULT_BUDGET,
  JobRunner,
  type JobState,
  type JobStore,
} from '@drawroid/core';
import { ScriptedLlm, StubBackend, type Script } from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsJobStore } from './job-store.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-runner-drain-failure-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const think: Script = () => ({
  params: { prompt: 'girl, beach', negativePrompt: 'lowres', seed: 7, steps: 20, cfgScale: 6 },
  rationale: '案',
});
const judge: Script = (call) => ({
  images: call.messages.user
    .filter((part) => part.type === 'image')
    .map(() => ({ score: 0.5, issues: [] })),
  nextChange: 'そのまま',
  canStop: false,
});

/** 次の listJobIds を、読んだ値を持ったまま、試験が開けるまで返さない。さらに、指定した writeState を1度だけ失敗させる */
function instrumentedStore(inner: JobStore) {
  let armed = false;
  let release: () => void = () => undefined;
  let reached: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const scanned = new Promise<void>((resolve) => (reached = resolve));
  let failStopWrite: string | undefined;
  const store = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'listJobIds') {
        return async () => {
          const ids = await target.listJobIds();
          if (armed) {
            armed = false;
            reached();
            await gate;
          }
          return ids;
        };
      }
      if (property === 'writeState') {
        return async (jobId: string, state: JobState) => {
          if (jobId === failStopWrite && state.status === 'stopped') {
            failStopWrite = undefined;
            throw new Error('disk full');
          }
          return target.writeState(jobId, state);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return {
    store,
    arm: () => (armed = true),
    scanned,
    release: () => release(),
    failStoppedWriteOnce: (jobId: string) => (failStopWrite = jobId),
  };
}

function setup(beforeJob?: () => Promise<void>) {
  const files = new FsJobStore(root);
  const instrumented = instrumentedStore(files);
  const logs: string[] = [];
  const runner = new JobRunner({
    store: instrumented.store,
    llm: new ScriptedLlm({ think, judge }),
    backend: new StubBackend(),
    budget: DEFAULT_BUDGET,
    permissions: basicPermissions({ width: 64, height: 64 }),
    log: (line) => logs.push(line),
    ...(beforeJob === undefined ? {} : { beforeJob }),
  });
  const submit = () =>
    files.createJob(
      {
        kind: 'auto',
        request: '海辺の少女',
        stopConditions: { aiJudgement: false, maxIterations: 1 },
        batchSize: 1,
      },
      { status: 'queued', carry: { intent: '海辺の少女', completedIterations: 0 } },
      new Date(),
    );
  return { files, instrumented, runner, submit, logs };
}

describe('when the queue scan fails', () => {
  it('skips a job whose directory vanished during the scan and still runs the others', async () => {
    const { files, instrumented, runner, submit, logs } = setup();
    const vanishing = await submit();
    const remaining = await submit();

    instrumented.arm();
    runner.kick();
    await instrumented.scanned;
    await rm(join(root, 'jobs', vanishing.jobId), { recursive: true });
    instrumented.release();
    await runner.idle();

    expect(await files.readState(remaining.jobId)).toMatchObject({ status: 'stopped' });
    // 人が消したのは異常ではないので、記録は増やさない
    expect(logs).toEqual([]);
  });

  it('skips a job whose files cannot be read, logs why, and still runs the others', async () => {
    const { files, runner, submit, logs } = setup();
    const broken = await submit();
    const healthy = await submit();
    await writeFile(join(root, 'jobs', broken.jobId, 'state.json'), '{ not json');

    runner.kick();
    await runner.idle();

    expect(await files.readState(healthy.jobId)).toMatchObject({ status: 'stopped' });
    // 走査のたびに残るので、件数は決めない
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).toContain(`ジョブ ${broken.jobId}`);
      expect(line).toContain('state.json');
    }
  });
});

describe('when running a queued job fails outside the job loop', () => {
  it('logs why, keeps draining the others, and runs the failed job again on the next kick', async () => {
    const { files, instrumented, runner, submit, logs } = setup();
    const failing = await submit();
    const other = await submit();
    instrumented.failStoppedWriteOnce(failing.jobId);

    runner.kick();
    await runner.idle();

    expect(await files.readState(other.jobId)).toMatchObject({ status: 'stopped' });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(`ジョブ ${failing.jobId}`);
    expect(logs[0]).toContain('disk full');

    runner.kick();
    await runner.idle();

    expect(await files.readState(failing.jobId)).toMatchObject({ status: 'stopped' });
  });

  it('logs why when the preparation before a job fails, and runs that job on the next kick', async () => {
    let failures = 1;
    const { files, runner, submit, logs } = setup(async () => {
      if (failures-- > 0) throw new Error('window unavailable');
    });
    const first = await submit();

    runner.kick();
    await runner.idle();

    expect(await files.readState(first.jobId)).toMatchObject({ status: 'queued' });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(`ジョブ ${first.jobId}`);
    expect(logs[0]).toContain('window unavailable');

    runner.kick();
    await runner.idle();

    expect(await files.readState(first.jobId)).toMatchObject({ status: 'stopped' });
  });
});
