import useSWR from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useIterations, useJob, useJobs } from './hooks.js';

vi.mock('swr', () => ({ default: vi.fn(() => ({})) }));

type Options = { refreshInterval?: number | ((data?: unknown) => number) };

function optionsPassedToSwr(): Options {
  const call = vi.mocked(useSWR).mock.calls.at(-1);
  return (call?.[2] ?? {}) as Options;
}

function intervalFor(data: unknown): number | undefined {
  const { refreshInterval } = optionsPassedToSwr();
  return typeof refreshInterval === 'function' ? refreshInterval(data) : refreshInterval;
}

beforeEach(() => {
  vi.mocked(useSWR).mockClear();
});

describe('useJobs', () => {
  it('polls the job list at a fixed interval', () => {
    useJobs();
    expect(intervalFor(undefined)).toBeGreaterThan(0);
  });
});

describe('useJob', () => {
  it('stops polling once the job has stopped', () => {
    useJob('job-1');
    expect(intervalFor({ state: { status: 'stopped' } })).toBe(0);
  });

  it('keeps polling while the job is running', () => {
    useJob('job-1');
    expect(intervalFor({ state: { status: 'running' } })).toBeGreaterThan(0);
  });
});

describe('useIterations', () => {
  it('does not poll when the job is not live', () => {
    useIterations('job-1', { live: false });
    expect(intervalFor(undefined)).toBe(0);
  });

  it('polls when the job is live', () => {
    useIterations('job-1', { live: true });
    expect(intervalFor(undefined)).toBeGreaterThan(0);
  });
});
