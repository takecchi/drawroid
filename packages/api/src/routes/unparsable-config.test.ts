// 起動したあとに config.json が JSON として読めなくなったとき、設定を読む口が、起動・doctor と同じ文で言うことを見る試験。
// 置き場所は本物のファイル（JSON.parse の失敗が、storage-fs から api まで届く道筋を通す）
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readBudgetOverrides, resolveBudgets } from '@drawroid/core';
import {
  readBudgetSettings,
  readGenerationProgressSettings,
  readLlmSettings,
} from '@drawroid/storage-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setup } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof setup>>;
let dir: string;
let configPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drawroid-unparsable-'));
  configPath = join(dir, 'config.json');
  ctx = await setup({
    llmSettings: {
      read: () => readLlmSettings(configPath),
      write: () => Promise.reject(new Error('この試験では書かない')),
    },
    generationProgressSettings: {
      read: async () => {
        await readGenerationProgressSettings(configPath);
        return { includePreview: false };
      },
      write: async () => undefined,
    },
    budgetSettings: {
      read: async () => {
        const { overrides, invalid } = readBudgetOverrides(await readBudgetSettings(configPath));
        return { overrides, effective: resolveBudgets(overrides), invalid };
      },
      write: async () => resolveBudgets({}),
    },
  });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(ctx.root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// node の版で文が違うので、同じ中身を JSON.parse に読ませて取る
const NODE_SAID = (() => {
  try {
    JSON.parse('{');
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('JSON.parse が失敗しなかった');
})();

async function breakConfig(text = '{') {
  await writeFile(configPath, text);
}

describe('settings routes while config.json is not JSON', () => {
  it.each([
    ['LLM', '/settings/llm'],
    ['generation progress', '/settings/generation-progress'],
    ['budgets', '/settings/budgets'],
  ])('says the same sentence as startup on GET %s settings', async (_name, path) => {
    await breakConfig();
    const res = await ctx.api.request(path);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: {
        kind: 'invalid_config',
        message: expect.stringMatching(/^config\.json が JSON として読めない（原文: .+）$/),
      },
    });
  });

  it('says the sentence of describeUnparsableConfig with the node message of the file', async () => {
    await breakConfig();
    const res = await ctx.api.request('/settings/llm');
    expect(await res.json()).toEqual({
      error: {
        kind: 'invalid_config',
        message: `config.json が JSON として読めない（原文: ${NODE_SAID}）`,
      },
    });
  });

  it('says the same sentence on the progress preview of an existing job', async () => {
    const submitted = await ctx.api.request('/jobs/auto', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request: '夕暮れの海辺の少女' }),
    });
    const { jobId } = (await submitted.json()) as { jobId: string };
    await breakConfig();

    const res = await ctx.api.request(`/jobs/${jobId}/progress-preview`);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: {
        kind: 'invalid_config',
        message: `config.json が JSON として読めない（原文: ${NODE_SAID}）`,
      },
    });
  });

  it('keeps the other sentence for JSON that is read but has the wrong shape', async () => {
    await breakConfig('{"llm":{"providers":{},"roles":{}}}');
    const res = await ctx.api.request('/settings/llm');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: {
        kind: 'invalid_config',
        message:
          'config.json の llm.roles.think が読めない（欄が無い）（原文: Invalid input: expected object, received undefined）',
      },
    });
  });

  it('does not say the message of an unexpected failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = await setup({
      llmSettings: {
        read: () => Promise.reject(new SyntaxError('/home/someone/secret/config.json')),
        write: () => Promise.reject(new Error('この試験では書かない')),
      },
    });
    try {
      const res = await broken.api.request('/settings/llm');
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: { kind: 'internal_error', message: 'サーバの中で想定外の失敗があった' },
      });
    } finally {
      await rm(broken.root, { recursive: true, force: true });
    }
  });
});
