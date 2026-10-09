import { createApi, type ApiDeps } from '@drawroid/api';
import { describe, expect, it, vi } from 'vitest';

import { wireGenerationProgress } from './progress-wiring.js';
import { stubDeps } from './test-support.js';

const PREVIEW = new Uint8Array([1, 2, 3, 4]);

describe('wiring the generation progress', () => {
  it('lets the API read the preview the job runner put, through the one place they share', async () => {
    const wiring = wireGenerationProgress({
      backend: {
        progress: async () => ({
          fraction: 0.5,
          step: 10,
          steps: 20,
          etaSeconds: 3,
          preview: { data: PREVIEW, mediaType: 'image/png' },
        }),
      },
      hubs: { get: () => ({ live: () => undefined }) },
      settings: { read: async () => ({ includePreview: true }), write: async () => undefined },
      onError: (error) => {
        throw error;
      },
    });
    const api = createApi({
      ...stubDeps(),
      store: { listJobIds: async () => ['job1'] } as unknown as ApiDeps['store'],
      ...wiring.api,
    });

    // ジョブ実行器の側で生成が始まったつもり
    const polling = await wiring.generationProgress.start({
      jobId: 'job1',
      conversationId: 'conv1',
      iteration: 1,
      signal: new AbortController().signal,
    });
    // 進み具合は既定の間隔（1秒）で読むので、最初の1回を待つ
    await vi.waitFor(() => expect(wiring.api.progressPreviews.get('job1')).toBeDefined(), {
      timeout: 3000,
    });

    const res = await api.request('/jobs/job1/progress-preview');
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PREVIEW);

    // 生成が終われば、API からも消える
    await polling.stop();
    expect((await api.request('/jobs/job1/progress-preview')).status).toBe(404);
  });
});
