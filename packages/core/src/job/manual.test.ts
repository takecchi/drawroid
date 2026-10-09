import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { BackendError } from '../backend-error.js';
import type { GenerationRequest, GenerationResult } from '../backend.js';
import { StubBackend } from '../testing/index.js';
import { ManualGenerationRunner } from './manual.js';
import type { JobStore, NewJobSpec, StoredGeneration } from './store.js';
import type { JobSpec, JobState } from './types.js';

class MemoryJobStore implements JobStore {
  readonly specs = new Map<string, JobSpec>();
  readonly states = new Map<string, JobState>();
  readonly generations = new Map<string, StoredGeneration[]>();

  async createJob(spec: NewJobSpec, state: JobState, now: Date): Promise<JobSpec> {
    const jobId = `job-${this.specs.size + 1}`;
    const full = { ...spec, jobId, createdAt: now.toISOString() } as JobSpec;
    this.specs.set(jobId, full);
    this.states.set(jobId, state);
    return full;
  }
  async listJobIds() {
    return [...this.specs.keys()];
  }
  async readJob(jobId: string) {
    return this.specs.get(jobId)!;
  }
  async writeJob(spec: JobSpec) {
    this.specs.set(spec.jobId, spec);
  }
  async readState(jobId: string) {
    return this.states.get(jobId)!;
  }
  async writeState(jobId: string, state: JobState) {
    this.states.set(jobId, state);
  }
  async writeGeneration(
    jobId: string,
    iteration: number,
    request: GenerationRequest,
    result: GenerationResult,
  ) {
    const list = this.generations.get(jobId) ?? [];
    list.push({
      iteration,
      request,
      images: result.images.map((image, index) => ({ index, seed: image.seed })),
    });
    this.generations.set(jobId, list);
  }
  async listGenerations(jobId: string) {
    return this.generations.get(jobId) ?? [];
  }
  async readGeneration(jobId: string, iteration: number) {
    return this.generations.get(jobId)?.find((g) => g.iteration === iteration);
  }
  async readImage() {
    return undefined;
  }
  // 以下は自動ジョブ（M2）の口。手動の生成は使わない
  readStage = notUsed;
  writeStage = notUsed;
  loadPreview = notUsed;
  markSent = notUsed;
  writeLlmCall = notUsed;
  listLlmCalls = notUsed;
  addIntervention = notUsed;
  listInterventions = notUsed;
  markInterventionApplied = notUsed;
  addReference = notUsed;
  listReferences = notUsed;
  writeReferenceGist = notUsed;
  readReferenceImage = notUsed;
  addMask = notUsed;
  readMask = notUsed;
  markMaskUsed = notUsed;
}

async function notUsed(): Promise<never> {
  throw new Error('手動の生成では使わない口');
}

const params = { prompt: 'a cat', steps: 4, cfgScale: 7, width: 64, height: 64, batchSize: 2 };

function setup(backend = new StubBackend()) {
  const store = new MemoryJobStore();
  return { backend, store, runner: new ManualGenerationRunner({ backend, store }) };
}

describe('ManualGenerationRunner', () => {
  it('stops after one generation and keeps what was generated', async () => {
    const { runner, store } = setup();
    const { jobId } = await runner.start({ ...params, seed: 5 });
    await runner.idle();

    expect(store.states.get(jobId)).toMatchObject({
      status: 'stopped',
      imagesGenerated: 2,
      reason: { kind: 'limit:iterations' },
    });
    expect(store.generations.get(jobId)).toEqual([
      {
        iteration: 1,
        request: expect.objectContaining({ prompt: 'a cat', seed: 5 }) as unknown,
        images: [
          { index: 0, seed: 5 },
          { index: 1, seed: 6 },
        ],
      },
    ]);
  });

  it('stops with the kind of the backend error so the screen can tell the cause', async () => {
    const backend = new StubBackend();
    backend.failNextGenerate(new BackendError('timeout', '応答が無い'));
    const { runner, store } = setup(backend);
    const { jobId } = await runner.start(params);
    await runner.idle();

    expect(store.states.get(jobId)).toMatchObject({
      status: 'stopped',
      imagesGenerated: 0,
      reason: { kind: 'error', detail: '応答が無い', backendErrorKind: 'timeout' },
    });
    expect(store.generations.get(jobId)).toBeUndefined();
  });

  it('refuses invalid parameters without creating a job or calling the backend', async () => {
    const { runner, store, backend } = setup();
    await expect(runner.start({ prompt: 'a cat' })).rejects.toThrow(ZodError);
    expect(store.specs.size).toBe(0);
    expect(backend.requests).toEqual([]);
  });

  it('refuses a request that points at images, without creating a job, since it cannot pass them yet', async () => {
    const { runner, store, backend } = setup();

    await expect(
      runner.start({ ...params, img2img: { image: 'refs/r1.png', denoisingStrength: 0.5 } }),
    ).rejects.toThrow(ZodError);
    expect(store.specs.size).toBe(0);
    expect(backend.requests).toEqual([]);
  });

  it('does not let two generations overlap', async () => {
    const backend = new StubBackend({ generateDelayMs: 10 });
    let running = 0;
    let maxRunning = 0;
    const generate = backend.generate.bind(backend);
    backend.generate = async (req, signal) => {
      maxRunning = Math.max(maxRunning, ++running);
      try {
        return await generate(req, signal);
      } finally {
        running--;
      }
    };
    const { runner, store } = setup(backend);
    const first = await runner.start(params);
    const second = await runner.start(params);
    await runner.idle();

    expect(maxRunning).toBe(1);
    expect(store.states.get(first.jobId)).toMatchObject({ status: 'stopped' });
    expect(store.states.get(second.jobId)).toMatchObject({ status: 'stopped' });
  });
});
