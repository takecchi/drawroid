// ジョブの保存の途中でプロセスが殺されたときを再現するための子プロセス。止められるまで手動ジョブの作成・state の書き換え・生成の保存を繰り返す
import { FsJobStore } from '../../dist/index.js';

const [root] = process.argv.slice(2);
const store = new FsJobStore(root);
const request = {
  prompt: 'a cat',
  negativePrompt: '',
  loras: [],
  steps: 4,
  cfgScale: 7,
  width: 64,
  height: 64,
  batchSize: 2,
};
const png = new Uint8Array(128 * 1024).fill(7);
const result = {
  images: [0, 1].map((i) => ({ png, seed: i, metadata: { index: i } })),
  metadata: { stub: true },
};

async function once() {
  const { jobId } = await store.createJob(
    { kind: 'manual', request },
    { status: 'queued' },
    new Date(),
  );
  const startedAt = new Date().toISOString();
  await store.writeState(jobId, { status: 'running', startedAt, imagesGenerated: 0 });
  await store.writeGeneration(jobId, 1, request, result);
  await store.writeState(jobId, {
    status: 'stopped',
    startedAt,
    stoppedAt: new Date().toISOString(),
    imagesGenerated: 2,
    reason: { kind: 'limit:iterations', detail: '手動の生成は1回で止まる' },
  });
}

// 1周し終えてから知らせる: 最初の保存より前に殺すと、何も無いだけで何も確かめられないため
await once();
process.stdout.write('started\n');
for (;;) await once();
