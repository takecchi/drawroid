// ループの途中でプロセスが殺されたときを再現するための子プロセス。止められるまでジョブを回す
import { DEFAULT_BUDGET, JobRunner, THINK_PARAM_KEYS } from '@drawroid/core';
import { ScriptedLlm, StubBackend } from '@drawroid/core/testing';

import { FsJobStore } from '../../dist/index.js';

const [root] = process.argv.slice(2);
const imageCount = (call) => call.messages.user.filter((part) => part.type === 'image').length;
const llm = new ScriptedLlm({
  think: (_call, n) => ({
    params: { prompt: `take ${n + 1}`, negativePrompt: '', seed: 1, steps: 20, cfg: 7 },
    rationale: 'r',
  }),
  judge: (call) => ({
    images: Array.from({ length: imageCount(call) }, () => ({ score: 0.5, issues: [] })),
    nextChange: 'n',
    canStop: false,
  }),
});
const runner = new JobRunner({
  store: new FsJobStore(root),
  llm,
  // 生成に時間をかけ、生成の途中で殺せるようにする
  backend: new StubBackend({ generateDelayMs: 300 }),
  budget: DEFAULT_BUDGET,
  allowed: THINK_PARAM_KEYS,
  defaults: { width: 64, height: 64, steps: 20, cfgScale: 7, negativePrompt: '' },
});
runner.kick();
await runner.idle();
