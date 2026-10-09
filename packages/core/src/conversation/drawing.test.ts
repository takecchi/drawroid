import { describe, expect, it } from 'vitest';

import type { JobState } from '../job/types.js';
import { mergePermissions } from '../permissions/permission.js';
import { basicPermissions } from '../loop/iteration-permissions.js';
import {
  describeJudgement,
  jobSummaryFor,
  narrowPermissions,
  summarizeJobForTalk,
} from './drawing.js';

const human = mergePermissions(basicPermissions({ width: 512, height: 512 }), {
  checkpoint: { mode: 'auto', choices: ['anime.safetensors', 'real.safetensors'] },
  loras: { mode: 'auto' },
});
const lists = {
  checkpoint: ['anime.safetensors', 'real.safetensors', 'other.safetensors'],
  lora: ['detail', 'style'],
};

describe('narrowPermissions', () => {
  it('lets the talking role turn off what the human left to the AI, or fix it to one of its candidates', () => {
    expect(
      narrowPermissions(
        human,
        {
          loras: { mode: 'off' },
          checkpoint: { mode: 'fixed', value: 'anime.safetensors' },
          steps: { mode: 'fixed', value: 30 },
        },
        lists,
      ),
    ).toEqual({
      ok: true,
      value: {
        loras: { mode: 'off' },
        checkpoint: { mode: 'fixed', value: 'anime.safetensors' },
        steps: { mode: 'fixed', value: 30 },
      },
    });
  });

  it('lets it narrow the candidates to fewer of the same', () => {
    expect(
      narrowPermissions(
        human,
        { checkpoint: { mode: 'auto', choices: ['real.safetensors'] } },
        lists,
      ),
    ).toMatchObject({ ok: true });
  });

  it.each([
    ['turning on what the human turned off', { vae: { mode: 'auto' } }, 'VAE'],
    ['fixing what the human turned off', { vae: { mode: 'fixed', value: 'vae.pt' } }, 'VAE'],
    [
      'fixing to a value outside the human candidates',
      { checkpoint: { mode: 'fixed', value: 'other.safetensors' } },
      'checkpoint',
    ],
    [
      'fixing to a name the backend does not have',
      { loras: { mode: 'fixed', value: [{ name: 'unknown', weight: 1 }] } },
      'LoRA',
    ],
    [
      'adding candidates the human did not choose',
      { checkpoint: { mode: 'auto', choices: ['other.safetensors'] } },
      'checkpoint',
    ],
    ['changing what the human fixed', { width: { mode: 'fixed', value: 1024 } }, '幅'],
    ['turning off what the human fixed', { width: { mode: 'auto' } }, '幅'],
    ['turning off a field every generation needs', { prompt: { mode: 'off' } }, 'プロンプト'],
  ] as const)('refuses %s, naming the parameter', (_, requested, label) => {
    const result = narrowPermissions(human, requested, lists);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain(label);
  });

  it('refuses a fixed value of the wrong shape', () => {
    expect(narrowPermissions(human, { steps: { mode: 'fixed', value: 'many' } }, lists).ok).toBe(
      false,
    );
  });
});

describe('describeJudgement', () => {
  it('turns the short fields of the judging role into sentences of a fixed form', () => {
    expect(
      describeJudgement({
        images: [
          { index: 0, score: 0.42, issues: ['手が崩れている', '背景が暗い'] },
          { index: 1, score: 0.8, issues: [] },
        ],
        nextChange: '手を隠す構図に',
        canStop: false,
      }),
    ).toBe(
      '1枚目は 0.42（手が崩れている・背景が暗い）、2枚目は 0.80（問題なし）。次は「手を隠す構図に」。',
    );
    expect(
      describeJudgement({
        images: [{ index: 0, score: 0.9, issues: [] }],
        nextChange: '',
        canStop: true,
      }),
    ).toBe('1枚目は 0.90（問題なし）。意図どおりなので、止めてよい。');
  });
});

describe('summarizeJobForTalk', () => {
  const carriedResult = (iteration: number, score: number) => ({
    iteration,
    imageIndex: 0,
    score,
    params: { prompt: 'p'.repeat(500) },
    issues: Array.from({ length: 20 }, (_, i) => `問題${i}`.repeat(10)),
    nextChange: '次'.repeat(500),
  });
  const running = (completedIterations: number): JobState => ({
    status: 'running',
    startedAt: '2026-10-09T00:00:00.000Z',
    imagesGenerated: completedIterations,
    carry: {
      intent: '要点'.repeat(300),
      completedIterations,
      best: carriedResult(1, 0.8),
      latest: carriedResult(completedIterations, 0.5),
    },
  });

  it('tells the state of the job from the short fields of carry only', () => {
    const summary = summarizeJobForTalk('job-1', running(3), { chars: 600 });

    expect(summary).toContain('job-1');
    expect(summary).toContain('走っている');
    expect(summary).toContain('3 回済み');
    expect(summary).toContain('最良は 1 回目の 0.80');
    expect(summary).not.toContain('p'.repeat(50));
  });

  it('stays within its budget however many iterations the job has run', () => {
    const lengths = [1, 30, 300].map(
      (n) => summarizeJobForTalk('job-1', running(n), { chars: 600 }).length,
    );

    expect(Math.max(...lengths)).toBeLessThanOrEqual(600);
  });

  it('says why a job stopped', () => {
    const stopped: JobState = {
      status: 'stopped',
      stoppedAt: '2026-10-09T00:10:00.000Z',
      imagesGenerated: 2,
      reason: { kind: 'limit:iterations', detail: '2 回に達した' },
      carry: { intent: '海辺の少女', completedIterations: 2 },
    };

    expect(summarizeJobForTalk('job-1', stopped, { chars: 600 })).toContain(
      '止まった（limit:iterations: 2 回に達した）',
    );
  });
});

describe('jobSummaryFor', () => {
  const at = '2026-10-09T00:00:00.000Z';
  const started = (seq: number, jobId: string) =>
    ({
      type: 'job.started',
      seq,
      at,
      jobId,
      request: '海辺',
      stopConditions: { aiJudgement: true },
    }) as const;

  it('tells the state of the newest job of the conversation, within the chars', async () => {
    const read: string[] = [];
    const summary = jobSummaryFor({
      jobs: {
        readState: async (jobId) => {
          read.push(jobId);
          return { status: 'queued', carry: { intent: '海辺の少女', completedIterations: 0 } };
        },
      },
      chars: async () => 40,
    });

    const text = await summary([started(1, 'old-job'), started(5, 'new-job')]);

    expect(read).toEqual(['new-job']);
    expect(text).toContain('new-job');
    expect(text!.length).toBeLessThanOrEqual(40);
  });

  it('says nothing when the conversation has no job', async () => {
    const summary = jobSummaryFor({
      jobs: { readState: () => Promise.reject(new Error('読まない')) },
      chars: async () => 600,
    });

    expect(await summary([])).toBeUndefined();
  });
});
