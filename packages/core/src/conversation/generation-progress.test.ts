import { describe, expect, it } from 'vitest';

import type { GenerationProgress } from '../backend.js';
import type { LiveEvent } from './events.js';
import { createGenerationProgress } from './generation-progress.js';
import { ProgressPreviews } from './progress-preview.js';

const png = { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' as const };

function fakeClock() {
  const pending: Array<() => void> = [];
  return {
    wait: (_ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        pending.push(resolve);
        signal.addEventListener('abort', () => resolve(), { once: true });
      }),
    async tick() {
      pending.shift()?.();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    },
  };
}

function setup(settings: () => Promise<{ includePreview: boolean }>) {
  const clock = fakeClock();
  const sent: Record<string, LiveEvent[]> = {};
  const previews = new ProgressPreviews();
  const errors: unknown[] = [];
  const progress: GenerationProgress = {
    fraction: 0.5,
    step: 10,
    steps: 20,
    etaSeconds: 3,
    preview: png,
  };
  const port = createGenerationProgress({
    backend: { progress: async () => progress },
    hubs: {
      get: (conversationId) => ({
        live: (event) => (sent[conversationId] ??= []).push(event),
      }),
    },
    previews,
    settings,
    wait: clock.wait,
    onError: (error) => errors.push(error),
  });
  const start = (conversationId: string | undefined) =>
    port.start({
      jobId: 'job-1',
      conversationId,
      iteration: 2,
      signal: new AbortController().signal,
    });
  return { clock, sent, previews, errors, start };
}

describe('generation progress to a conversation', () => {
  it('sends nothing for a job that does not belong to a conversation', async () => {
    const { clock, sent, previews, start } = setup(async () => ({ includePreview: true }));
    const polling = await start(undefined);
    await clock.tick();
    await polling.stop();
    expect(sent).toEqual({});
    expect(previews.get('job-1')).toBeUndefined();
  });

  it('sends generation.progress to the hub of the conversation of the job', async () => {
    const { clock, sent, start } = setup(async () => ({ includePreview: false }));
    const polling = await start('conv-1');
    await clock.tick();
    await polling.stop();
    expect(Object.keys(sent)).toEqual(['conv-1']);
    expect(sent['conv-1']).toEqual([
      {
        type: 'generation.progress',
        jobId: 'job-1',
        iteration: 2,
        progress: 0.5,
        step: 10,
        steps: 20,
        etaMs: 3000,
      },
    ]);
  });

  it('keeps the preview and sends its url only when includePreview is true', async () => {
    const { clock, sent, previews, start } = setup(async () => ({ includePreview: true }));
    const polling = await start('conv-1');
    await clock.tick();
    expect(previews.get('job-1')).toEqual(png);
    expect(sent['conv-1']?.[0]).toMatchObject({
      previewUrl: '/api/jobs/job-1/progress-preview',
    });
    await polling.stop();
  });

  it('does not keep or send the preview when includePreview is false', async () => {
    const { clock, sent, previews, start } = setup(async () => ({ includePreview: false }));
    const polling = await start('conv-1');
    await clock.tick();
    expect(previews.get('job-1')).toBeUndefined();
    expect(sent['conv-1']?.[0]).not.toHaveProperty('previewUrl');
    await polling.stop();
  });

  it('clears the preview on stop', async () => {
    const { clock, previews, start } = setup(async () => ({ includePreview: true }));
    const polling = await start('conv-1');
    await clock.tick();
    expect(previews.get('job-1')).toEqual(png);
    await polling.stop();
    expect(previews.get('job-1')).toBeUndefined();
  });

  it('still sends progress without a preview when the settings cannot be read, and reports it', async () => {
    const failure = new Error('config.json が不正');
    const { clock, sent, previews, errors, start } = setup(async () => {
      throw failure;
    });
    const polling = await start('conv-1');
    await clock.tick();
    await polling.stop();
    expect(errors).toEqual([failure]);
    expect(sent['conv-1']).toHaveLength(1);
    expect(sent['conv-1']?.[0]).not.toHaveProperty('previewUrl');
    expect(previews.get('job-1')).toBeUndefined();
  });
});
