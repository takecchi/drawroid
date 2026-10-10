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
  controlnet: { mode: 'auto', choices: ['canny'] },
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

  it('lets it leave to the AI what the human left to the AI without choosing candidates', () => {
    expect(narrowPermissions(human, { loras: { mode: 'auto' } }, lists)).toMatchObject({
      ok: true,
    });
  });

  it('lets it fix ControlNet to a model among the human candidates', () => {
    expect(
      narrowPermissions(
        human,
        { controlnet: { mode: 'fixed', value: [{ image: 'image:1-0', model: 'canny' }] } },
        lists,
      ),
    ).toMatchObject({ ok: true });
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
    [
      'dropping the candidates the human chose, which would open every candidate',
      { checkpoint: { mode: 'auto' } },
      'checkpoint',
    ],
    [
      'fixing ControlNet to a model the human did not choose',
      {
        controlnet: {
          mode: 'fixed',
          value: [{ image: 'image:1-0', model: 'other-canny' }],
        },
      },
      'ControlNet',
    ],
    ['changing what the human fixed', { width: { mode: 'fixed', value: 1024 } }, '幅'],
    ['turning off what the human fixed', { width: { mode: 'auto' } }, '幅'],
    ['turning off a field every generation needs', { prompt: { mode: 'off' } }, 'プロンプト'],
  ] as const)('refuses %s, naming the parameter', (_, requested, label) => {
    const result = narrowPermissions(human, requested, lists);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain(label);
  });

  describe('a fixed Hires. fix, whose second pass names its own checkpoint, sampler and prompt', () => {
    const humanWithHires = mergePermissions(human, {
      hiresFix: { mode: 'auto' },
      sampler: { mode: 'auto', choices: ['Euler a'] },
      negativePrompt: { mode: 'fixed', value: 'lowres' },
    });
    const listsWithHires = {
      ...lists,
      upscaler: ['R-ESRGAN 4x+'],
      sampler: ['Euler a', 'DPM++ 2M'],
    };
    const hires = (extra: Record<string, unknown>) => ({
      hiresFix: {
        mode: 'fixed',
        value: {
          upscaler: 'R-ESRGAN 4x+',
          scale: 2,
          steps: 0,
          denoisingStrength: 0.4,
          ...extra,
        },
      },
    });

    it.each([
      [
        'a checkpoint outside the human candidates',
        { checkpoint: 'other.safetensors' },
        'checkpoint',
      ],
      ['a sampler outside the human candidates', { sampler: 'DPM++ 2M' }, 'サンプラー'],
      [
        'a negative prompt other than the one the human fixed',
        { negativePrompt: 'none' },
        'ネガティブプロンプト',
      ],
    ] as const)('refuses %s, naming the parameter', (_, extra, label) => {
      const result = narrowPermissions(humanWithHires, hires(extra), listsWithHires);

      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toContain(label);
    });

    it('takes a second pass that stays inside what the human allowed', () => {
      expect(
        narrowPermissions(
          humanWithHires,
          hires({ checkpoint: 'real.safetensors', sampler: 'Euler a', negativePrompt: 'lowres' }),
          listsWithHires,
        ),
      ).toMatchObject({ ok: true });
    });

    it('takes a second pass that names nothing of its own', () => {
      expect(narrowPermissions(humanWithHires, hires({}), listsWithHires)).toMatchObject({
        ok: true,
      });
    });
  });

  // 話す役が固定する値の、安全のための上限。人間が AI に任せたものでも、これを超えて固定させない
  describe('a fixed value past the safety limit', () => {
    const humanLeavesAll = mergePermissions(human, {
      width: { mode: 'auto' },
      height: { mode: 'auto' },
      steps: { mode: 'auto' },
      prompt: { mode: 'auto' },
      negativePrompt: { mode: 'auto' },
      hiresFix: { mode: 'auto' },
    });
    const listsWithUpscaler = { ...lists, upscaler: ['R-ESRGAN 4x+'] };
    const hires = (extra: Record<string, unknown>) => ({
      mode: 'fixed',
      value: { upscaler: 'R-ESRGAN 4x+', scale: 2, steps: 0, denoisingStrength: 0.4, ...extra },
    });
    const long = (length: number) => 'あ'.repeat(length);

    it.each([
      ['steps over 150', { steps: { mode: 'fixed', value: 151 } }, 'steps'],
      ['a width over 4096', { width: { mode: 'fixed', value: 4097 } }, '幅'],
      ['a height over 4096', { height: { mode: 'fixed', value: 4097 } }, '高さ'],
      ['a Hires. fix scale over 4', { hiresFix: hires({ scale: 4.01 }) }, 'Hires. fix'],
      [
        'a prompt over 4000 characters',
        { prompt: { mode: 'fixed', value: long(4001) } },
        'プロンプト',
      ],
      [
        'a negative prompt over 4000 characters',
        { negativePrompt: { mode: 'fixed', value: long(4001) } },
        'ネガティブプロンプト',
      ],
      [
        'a second-pass prompt over 4000 characters',
        { hiresFix: hires({ prompt: long(4001) }) },
        'プロンプト',
      ],
      // 二段目の steps も、一段目と同じくバックエンドを長く占められる
      ['second-pass steps over 150', { hiresFix: hires({ steps: 151 }) }, 'steps'],
    ] as const)('refuses %s, naming the parameter', (_, requested, label) => {
      const result = narrowPermissions(humanLeavesAll, requested, listsWithUpscaler);

      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toContain(label);
      expect(!result.ok && result.reason).toContain('上限');
    });

    it('takes values right at the limits', () => {
      expect(
        narrowPermissions(
          humanLeavesAll,
          {
            steps: { mode: 'fixed', value: 150 },
            width: { mode: 'fixed', value: 4096 },
            height: { mode: 'fixed', value: 4096 },
            hiresFix: hires({ scale: 4, steps: 150, prompt: long(4000) }),
            prompt: { mode: 'fixed', value: long(4000) },
            negativePrompt: { mode: 'fixed', value: long(4000) },
          },
          listsWithUpscaler,
        ),
      ).toMatchObject({ ok: true });
    });

    // 上限は話す役の求めにだけ掛ける。人間が固定した値は、人間の決めたこととしてそのまま通す
    it('leaves a value the human fixed past the limit as it is', () => {
      const humanFixedLarge = mergePermissions(human, { steps: { mode: 'fixed', value: 200 } });

      expect(
        narrowPermissions(humanFixedLarge, { steps: { mode: 'fixed', value: 200 } }, lists),
      ).toMatchObject({ ok: true });
    });
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
    expect(summary).toContain('最良は 1 回目の 1枚目で 0.80');
    expect(summary).not.toContain('p'.repeat(50));
  });

  it('names the image a human chose when the job stopped on it', () => {
    const stopped: JobState = {
      status: 'stopped',
      stoppedAt: '2026-10-09T00:10:00.000Z',
      imagesGenerated: 4,
      reason: { kind: 'adopted', detail: '人間が画像を選んだ' },
      carry: {
        intent: '海辺の少女',
        completedIterations: 2,
        best: { ...carriedResult(2, 1), imageIndex: 1, issues: [] },
      },
    };

    const summary = summarizeJobForTalk('job-1', stopped, { chars: 600 });

    expect(summary).toContain('止まった（adopted: 人間が画像を選んだ）');
    expect(summary).toContain('人が選んだのは 2 回目の 2枚目（問題なし）');
    expect(summary).not.toContain('最良は');
  });

  it('says best, not chosen, when the job stopped for any other reason', () => {
    const stopped: JobState = {
      status: 'stopped',
      stoppedAt: '2026-10-09T00:10:00.000Z',
      imagesGenerated: 4,
      reason: { kind: 'ai', detail: '見る役が止めてよいと言った' },
      carry: {
        intent: '海辺の少女',
        completedIterations: 2,
        best: { ...carriedResult(2, 0.9), imageIndex: 1, issues: [] },
      },
    };

    const summary = summarizeJobForTalk('job-1', stopped, { chars: 600 });

    // 人が選んでいないのに「人が選んだ」と書かない
    expect(summary).toContain('最良は 2 回目の 2枚目で 0.90');
    expect(summary).not.toContain('人が選んだ');
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
