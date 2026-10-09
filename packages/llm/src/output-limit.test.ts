import { DEFAULT_BUDGET, estimateMaxOutputTokens } from '@drawroid/core';
import { describe, expect, it } from 'vitest';

import { llmConfigSchema } from './config.js';
import { outputLimitWarnings } from './output-limit.js';

const estimates = estimateMaxOutputTokens(DEFAULT_BUDGET);
const config = (roles: object) =>
  llmConfigSchema.parse({
    providers: { local: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:11434/v1' } },
    roles,
  });
const role = (maxOutputTokens?: number) => ({
  provider: 'local',
  model: 'qwen',
  ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
});

describe('outputLimitWarnings', () => {
  it('warns about each role whose output limit is below the estimate, naming the key to raise', () => {
    const warnings = outputLimitWarnings(
      config({ think: role(1024), judge: role(4096) }),
      estimates,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      role: 'think',
      configKey: 'think',
      maxOutputTokens: 1024,
      estimatedOutputTokens: estimates.think,
    });
    expect(warnings[0]?.message).toContain('「出力の上限（トークン）」を 2048 以上に上げる');
  });

  it('points the judge role at the settings of the think role when it has none of its own', () => {
    const warnings = outputLimitWarnings(config({ think: role(1024) }), estimates);
    expect(warnings.map((w) => [w.role, w.configKey])).toEqual([
      ['think', 'think'],
      ['judge', 'think'],
    ]);
    expect(warnings[1]?.message).toContain('（見る役は考える役の設定を使う）');
  });

  it('gives no warning with the default limits', () => {
    expect(outputLimitWarnings(config({ think: role() }), estimates)).toEqual([]);
  });
});
