import { mutate } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { keys } from './keys.js';
import { addInstruction, changeStopConditions } from './mutations.js';

vi.mock('swr', () => ({ mutate: vi.fn(async () => undefined) }));

vi.mock('./client.js', () => {
  const post = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  return { client: { jobs: { auto: { ':jobId': { interventions: { $post: post } } } } } };
});

const refreshedKeys = () => vi.mocked(mutate).mock.calls.map(([key]) => key);

beforeEach(() => {
  vi.mocked(mutate).mockClear();
});

describe('changeStopConditions', () => {
  it('refetches the stop conditions of the job afterwards', async () => {
    await changeStopConditions('job-1', { maxIterations: 5 });
    expect(refreshedKeys()).toContain(keys.stopConditions('job-1'));
  });
});

describe('addInstruction', () => {
  it('refetches the interventions of the job afterwards', async () => {
    await addInstruction('job-1', 'もっと明るく');
    expect(refreshedKeys()).toContain(keys.interventions('job-1'));
  });
});
