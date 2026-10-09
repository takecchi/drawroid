import { describe, expect, it } from 'vitest';

import type { GenerationProgress } from '../backend.js';
import { liveEventSchema, type LiveEvent } from './events.js';
import { startProgressPolling } from './progress-poller.js';

type ProgressEvent = Extract<LiveEvent, { type: 'generation.progress' }>;

const png = { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' as const };

/** 呼ばれたら、試験が tick() で解くまで待つ偽の時計 */
function fakeClock() {
  const pending: Array<() => void> = [];
  const requested: number[] = [];
  return {
    requested,
    wait: (ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        requested.push(ms);
        pending.push(resolve);
        signal.addEventListener('abort', () => resolve(), { once: true });
      }),
    async tick() {
      pending.shift()?.();
      // 読み・emit が終わるまで、マイクロタスクを流す
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    },
  };
}

function setup(
  progress:
    | ((
        signal: AbortSignal,
        options?: { includePreview?: boolean },
      ) => Promise<GenerationProgress | undefined>)
    | undefined,
  extra: Partial<Parameters<typeof startProgressPolling>[0]> = {},
) {
  const clock = fakeClock();
  const events: ProgressEvent[] = [];
  const errors: unknown[] = [];
  const outer = new AbortController();
  const polling = startProgressPolling({
    backend: progress === undefined ? {} : { progress },
    jobId: 'job-1',
    iteration: 2,
    emit: (event) => events.push(event),
    signal: outer.signal,
    wait: clock.wait,
    onError: (error) => errors.push(error),
    ...extra,
  });
  return { clock, events, errors, outer, polling };
}

const half: GenerationProgress = { fraction: 0.5, step: 10, steps: 20, etaSeconds: 3 };

describe('startProgressPolling', () => {
  it('reads once per interval and emits generation.progress', async () => {
    const { clock, events, polling } = setup(async () => half, { intervalMs: 250 });

    expect(events).toEqual([]);
    await clock.tick();
    await clock.tick();

    expect(clock.requested.slice(0, 2)).toEqual([250, 250]);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: 'generation.progress',
      jobId: 'job-1',
      iteration: 2,
      progress: 0.5,
      step: 10,
      steps: 20,
      etaMs: 3000,
    });
    await polling.stop();
  });

  it('waits one second between reads by default', async () => {
    const { clock, polling } = setup(async () => half);
    await clock.tick();
    expect(clock.requested[0]).toBe(1000);
    await polling.stop();
  });

  it('converts etaSeconds to milliseconds and omits null fields', async () => {
    const { clock, events, polling } = setup(async () => ({
      fraction: 0.25,
      step: null,
      steps: null,
      etaSeconds: null,
    }));
    await clock.tick();

    expect(events).toEqual([
      { type: 'generation.progress', jobId: 'job-1', iteration: 2, progress: 0.25 },
    ]);
    await polling.stop();
  });

  it('omits steps below 1 because the event requires a positive number', async () => {
    const { clock, events, polling } = setup(async () => ({
      fraction: 0,
      step: 0,
      steps: 0,
      etaSeconds: 0,
    }));
    await clock.tick();

    expect(events[0]).toMatchObject({ step: 0, etaMs: 0 });
    expect(events[0]).not.toHaveProperty('steps');
    expect(liveEventSchema.safeParse(events[0]).success).toBe(true);
    await polling.stop();
  });

  it('does not emit while nothing is running', async () => {
    const { clock, events, polling } = setup(async () => undefined);
    await clock.tick();
    await clock.tick();

    expect(events).toEqual([]);
    await polling.stop();
  });

  it('reports a failed read and reads again at the next interval', async () => {
    let calls = 0;
    const { clock, events, errors, polling } = setup(async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return half;
    });
    await clock.tick();
    expect(errors).toHaveLength(1);
    expect(events).toEqual([]);

    await clock.tick();
    expect(events).toHaveLength(1);
    await polling.stop();
  });

  it('stops on stop() and never emits afterwards', async () => {
    const { clock, events, polling } = setup(async () => half);
    await clock.tick();
    await polling.stop();
    await clock.tick();

    expect(events).toHaveLength(1);
  });

  it('does not emit a read that finished after stop()', async () => {
    let release: (value: GenerationProgress) => void = () => undefined;
    const { clock, events, polling } = setup(
      () => new Promise<GenerationProgress>((resolve) => (release = resolve)),
    );
    await clock.tick();
    const stopped = polling.stop();
    release(half);
    await stopped;

    expect(events).toEqual([]);
  });

  it('lets stop() be called twice', async () => {
    const { polling } = setup(async () => half);
    await polling.stop();
    await expect(polling.stop()).resolves.toBeUndefined();
  });

  it('stops when the outer signal aborts', async () => {
    const { clock, events, outer, polling } = setup(async () => half);
    await clock.tick();
    outer.abort();
    await clock.tick();
    await polling.stop();

    expect(events).toHaveLength(1);
  });

  it('waits for the running read before stop() resolves', async () => {
    let finished = false;
    let release: () => void = () => undefined;
    const { clock, polling } = setup(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => {
            finished = true;
            resolve(undefined);
          };
        }),
    );
    await clock.tick();
    let stopResolved = false;
    const stopped = polling.stop().then(() => (stopResolved = true));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(stopResolved).toBe(false);

    release();
    await stopped;
    expect(finished).toBe(true);
  });

  it('never overlaps reads', async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const { clock, polling } = setup(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return half;
    });
    await clock.tick();
    await clock.tick();
    await clock.tick();
    expect(maxActive).toBe(1);
    expect(releases).toHaveLength(1);

    releases[0]?.();
    await clock.tick();
    await clock.tick();
    expect(releases).toHaveLength(2);
    const stopped = polling.stop();
    releases[1]?.();
    await stopped;
  });

  it('does nothing for a backend without progress', async () => {
    const { clock, events, polling } = setup(undefined);
    await clock.tick();

    expect(clock.requested).toEqual([]);
    expect(events).toEqual([]);
    await expect(polling.stop()).resolves.toBeUndefined();
  });

  it('passes the preview on only when includePreview is on', async () => {
    const previews: unknown[] = [];
    const asked: Array<boolean | undefined> = [];
    const withPreview = async (_: AbortSignal, options?: { includePreview?: boolean }) => {
      asked.push(options?.includePreview);
      return { ...half, preview: png };
    };

    const off = setup(withPreview, {
      onPreview: (p) => previews.push(p),
      previewUrl: '/api/jobs/job-1/progress-preview',
    });
    await off.clock.tick();
    await off.polling.stop();
    expect(previews).toEqual([]);
    expect(off.events[0]).not.toHaveProperty('previewUrl');

    const on = setup(withPreview, {
      includePreview: true,
      onPreview: (p) => previews.push(p),
      previewUrl: '/api/jobs/job-1/progress-preview',
    });
    await on.clock.tick();
    await on.polling.stop();
    expect(previews).toEqual([png]);
    expect(on.events[0]?.previewUrl).toBe('/api/jobs/job-1/progress-preview');
    expect(asked).toEqual([false, true]);
  });

  it('omits previewUrl when the backend returned no preview', async () => {
    const { clock, events, polling } = setup(async () => half, {
      includePreview: true,
      previewUrl: '/x',
    });
    await clock.tick();

    expect(events[0]).not.toHaveProperty('previewUrl');
    await polling.stop();
  });

  it('emits events that pass liveEventSchema', async () => {
    const { clock, events, polling } = setup(async () => ({ ...half, preview: png }), {
      includePreview: true,
      previewUrl: '/api/jobs/job-1/progress-preview',
    });
    await clock.tick();

    expect(events).toHaveLength(1);
    expect(liveEventSchema.safeParse(events[0]).success).toBe(true);
    await polling.stop();
  });

  it('with the default clock, an abort ends the wait immediately', async () => {
    const outer = new AbortController();
    const polling = startProgressPolling({
      backend: { progress: async () => half },
      jobId: 'j',
      iteration: 1,
      emit: () => undefined,
      signal: outer.signal,
      intervalMs: 60_000,
    });
    await polling.stop();
    expect(outer.signal.aborted).toBe(false);
  });
});
