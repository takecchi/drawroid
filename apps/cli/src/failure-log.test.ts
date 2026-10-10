import type { JobState, JobStore, StopReason } from '@drawroid/core';
import { describe, expect, it } from 'vitest';

import { logFailedJobs } from './failure-log.js';

const stopped = (reason: StopReason): JobState =>
  ({
    status: 'stopped',
    startedAt: '2026-10-10T00:00:00.000Z',
    stoppedAt: '2026-10-10T00:01:00.000Z',
    imagesGenerated: 0,
    reason,
  }) as JobState;

function wrapped(writeState: JobStore['writeState'] = async () => {}) {
  const logged: string[] = [];
  const inner = {
    writeState,
    readState: async () => stopped({ kind: 'ai', detail: 'x' }),
  } as unknown as JobStore;
  return { store: logFailedJobs(inner, (line) => logged.push(line)), logged };
}

describe('logFailedJobs', () => {
  // 言葉は画面にそろえる: 止まりのカードの「描くのを止めた」と、ジョブの詳細に出す止まった理由の文
  it('logs one line, in the words of the screen, when a job stops as an error', async () => {
    const { store, logged } = wrapped();

    await store.writeState(
      'job-7',
      stopped({
        kind: 'error',
        detail: '生成の段: http://127.0.0.1:7860/ に繋がらない',
        backendErrorKind: 'unreachable',
      }),
    );

    expect(logged).toEqual([
      'drawroid: 描くのを止めた（ジョブ job-7）: 生成の段: http://127.0.0.1:7860/ に繋がらない',
    ]);
  });

  it.each([
    ['the AI judged it done', { kind: 'ai', detail: '意図どおり' }],
    ['it reached the limit', { kind: 'limit:iterations', detail: '回数の上限' }],
    ['a person stopped it', { kind: 'human', detail: '人が止めた' }],
    ['a person chose an image', { kind: 'adopted', detail: '人が選んだ' }],
  ] satisfies [string, StopReason][])('logs nothing when %s', async (_, reason) => {
    const { store, logged } = wrapped();

    await store.writeState('job-7', stopped(reason));
    await store.writeState('job-7', { status: 'running' } as JobState);

    expect(logged).toEqual([]);
  });

  // ジョブのファイルが正: 書けなかった止まりは出さない
  it('logs nothing when the stop could not be written', async () => {
    const { store, logged } = wrapped(() => Promise.reject(new Error('書けない')));

    await expect(
      store.writeState('job-7', stopped({ kind: 'error', detail: '見る段: 失敗' })),
    ).rejects.toThrow('書けない');
    expect(logged).toEqual([]);
  });

  it('passes every other call through to the store it wraps', async () => {
    const { store } = wrapped();

    expect(await store.readState('job-7')).toMatchObject({ reason: { kind: 'ai' } });
  });
});
