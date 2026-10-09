import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApi } from '@drawroid/api';
import { DEFAULT_BUDGETS } from '@drawroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBudgetSettings } from './budget-settings.js';
import { stubDeps } from './test-support.js';

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drawroid-cli-budget-'));
  configPath = join(dir, 'config.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('budget settings of the CLI', () => {
  it('resolves to the defaults when config.json has no budgets', async () => {
    const { overrides, effective } = await createBudgetSettings(configPath).read();

    expect(overrides).toEqual({});
    expect(effective).toEqual(DEFAULT_BUDGETS);
  });

  it('overlays what was written onto the defaults and reads it back', async () => {
    const settings = createBudgetSettings(configPath);

    const written = await settings.write({ imageLongEdge: 256 });
    const read = await settings.read();

    expect(written.imageLongEdge).toBe(256);
    expect(read.overrides).toEqual({ imageLongEdge: 256 });
    expect(read.effective).toEqual({ ...DEFAULT_BUDGETS, imageLongEdge: 256 });
  });

  // 読めない欄だけを既定に戻し、理由を返す（許可の #100 と同じ作り）: 1 か所の書き損じで、投入が止まらないように
  it('drops only the fields it cannot read, back to the defaults, with the reasons', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        budgets: { imageLongEdge: 0, text: { prompt: 50, negativePrompt: 'x' }, imageShortEdge: 3 },
      }),
    );

    const { overrides, effective, invalid } = await createBudgetSettings(configPath).read();

    expect(overrides).toEqual({ text: { prompt: 50 } });
    expect(effective.imageLongEdge).toBe(DEFAULT_BUDGETS.imageLongEdge);
    expect(effective.text.prompt).toBe(50);
    expect(effective.text.negativePrompt).toBe(DEFAULT_BUDGETS.text.negativePrompt);
    expect(invalid.map((i) => i.path).sort()).toEqual(
      ['imageLongEdge', 'imageShortEdge', 'text.negativePrompt'].sort(),
    );
    expect(invalid.every((i) => i.reason !== '')).toBe(true);
  });

  it('drops all of budgets when it is not an object of fields', async () => {
    await writeFile(configPath, JSON.stringify({ budgets: 7 }));

    const { overrides, effective, invalid } = await createBudgetSettings(configPath).read();

    expect(overrides).toEqual({});
    expect(effective).toEqual(DEFAULT_BUDGETS);
    expect(invalid).toEqual([{ path: '*', reason: expect.any(String) }]);
  });

  it('still takes a job with broken budgets, and tells the reasons through the API', async () => {
    await writeFile(
      configPath,
      JSON.stringify({ budgets: { imageLongEdge: 0, text: { prompt: 50 } } }),
    );
    const app = createApi({ ...stubDeps(dir), budgetSettings: createBudgetSettings(configPath) });

    const submitted = await app.request('/jobs/auto', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request: '夕暮れの海辺の少女' }),
    });
    expect(submitted.status).toBe(202);
    const { jobId } = (await submitted.json()) as { jobId: string };
    const job = (await (await app.request(`/jobs/${jobId}`)).json()) as {
      spec: { budgets: typeof DEFAULT_BUDGETS };
    };
    expect(job.spec.budgets.imageLongEdge).toBe(DEFAULT_BUDGETS.imageLongEdge);
    expect(job.spec.budgets.text.prompt).toBe(50);

    const settings = await app.request('/settings/budgets');
    expect(settings.status).toBe(200);
    expect(await settings.json()).toMatchObject({
      overrides: { text: { prompt: 50 } },
      invalid: [{ path: 'imageLongEdge', reason: expect.any(String) }],
    });
  });
});
