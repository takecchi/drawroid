// ポーリングの設定を見る試験（#68 の J9・J10・J11）。useSWR を差し替え、各フックが渡すキーと refreshInterval を確かめる
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useConversation, useIterations, useJob, useJobs } from './hooks.js';
import { keys } from './keys.js';

type Options = { refreshInterval?: number | ((data: unknown) => number) };
const calls: { key: unknown; options: Options | undefined }[] = [];

vi.mock('swr', () => ({
  default: (key: unknown, _fetcher: unknown, options?: Options) => {
    calls.push({ key, options });
    return { data: undefined, error: undefined };
  },
  mutate: vi.fn(),
}));

beforeEach(() => {
  calls.length = 0;
});

function intervalFor(data: unknown): number | undefined {
  const interval = calls.at(-1)?.options?.refreshInterval;
  return typeof interval === 'function' ? interval(data) : interval;
}

describe('polling', () => {
  it('keeps polling the job list', () => {
    useJobs();
    expect(calls.at(-1)?.key).toBe(keys.jobs);
    expect(intervalFor(undefined)).toBeGreaterThan(0);
  });

  it('polls a job while it runs and stops once it has stopped', () => {
    useJob('j1');
    expect(calls.at(-1)?.key).toBe(keys.job('j1'));
    expect(intervalFor({ state: { status: 'running' } })).toBeGreaterThan(0);
    expect(intervalFor({ state: { status: 'queued' } })).toBeGreaterThan(0);
    expect(intervalFor({ state: { status: 'stopped' } })).toBe(0);
  });

  // 別のタブで名前を変えたときにも追う。読むのは会話1つで、一覧（全会話の要約）ではない
  it('keeps polling one conversation, not the list, for its title', () => {
    useConversation('c1');
    expect(calls.at(-1)?.key).toBe(keys.conversation('c1'));
    expect(intervalFor(undefined)).toBeGreaterThan(0);
  });

  it('polls the iterations only while the job is live', () => {
    useIterations('j1', { live: true });
    expect(calls.at(-1)?.key).toBe(keys.iterations('j1'));
    expect(intervalFor(undefined)).toBeGreaterThan(0);

    useIterations('j1', { live: false });
    expect(intervalFor(undefined)).toBe(0);
  });
});
