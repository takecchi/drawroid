import { describe, expect, it } from 'vitest';

import {
  BACKEND_FEATURES,
  CANDIDATE_KINDS,
  candidateSchema,
  generationRequestSchema,
  type ImageBackend,
} from '../backend.js';
import { BackendError } from '../backend-error.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface ContractBackend {
  backend: ImageBackend;
  close?: () => Promise<void>;
}

export interface ImageBackendContractTarget {
  // 正常に繋がるバックエンド。候補は種類ごとに1件以上持たせること
  connected(): Promise<ContractBackend>;
  // 繋がらないバックエンド（落ちている・ポートが違う）
  unreachable(): Promise<ContractBackend>;
}

// アダプタが満たすべき振る舞い。M1 の Forge・M6 の A1111 のアダプタに、同じ試験をそのまま当てる
export function describeImageBackendContract(
  name: string,
  target: ImageBackendContractTarget,
): void {
  const request = generationRequestSchema.parse({
    prompt: 'a cat',
    steps: 4,
    cfgScale: 7,
    seed: 42,
    width: 64,
    height: 64,
    batchSize: 2,
  });

  async function withBackend(
    open: () => Promise<ContractBackend>,
    use: (backend: ImageBackend) => Promise<void>,
  ): Promise<void> {
    const { backend, close } = await open();
    try {
      await use(backend);
    } finally {
      await close?.();
    }
  }

  describe(`ImageBackend contract: ${name}`, () => {
    it('reports capabilities with only known features', async () => {
      await withBackend(target.connected, async (backend) => {
        const { unavailable } = await backend.probe();
        for (const item of unavailable) {
          expect(BACKEND_FEATURES).toContain(item.feature);
          expect(item.reason).not.toBe('');
        }
      });
    });

    it('lists candidates of every kind', async () => {
      await withBackend(target.connected, async (backend) => {
        for (const kind of CANDIDATE_KINDS) {
          const candidates = await backend.listCandidates(kind);
          expect(candidates.length, kind).toBeGreaterThan(0);
          for (const candidate of candidates) candidateSchema.parse(candidate);
        }
      });
    });

    it('generates as many PNG images as the batch size, reporting the seed it used', async () => {
      await withBackend(target.connected, async (backend) => {
        const result = await backend.generate(request, new AbortController().signal);
        expect(result.images).toHaveLength(request.batchSize);
        for (const image of result.images) {
          expect(Array.from(image.png.slice(0, 8))).toEqual(PNG_SIGNATURE);
        }
        expect(result.images[0]?.seed).toBe(request.seed);
      });
    });

    it('rejects with an aborted error when the signal is already aborted', async () => {
      await withBackend(target.connected, async (backend) => {
        const controller = new AbortController();
        controller.abort();
        await expect(backend.generate(request, controller.signal)).rejects.toMatchObject({
          name: 'BackendError',
          kind: 'aborted',
        });
      });
    });

    it('accepts an interrupt even when nothing is running', async () => {
      await withBackend(target.connected, async (backend) => {
        await expect(backend.interrupt()).resolves.toBeUndefined();
      });
    });

    it('reports an unreachable backend as unreachable on every call', async () => {
      await withBackend(target.unreachable, async (backend) => {
        const calls = [
          () => backend.probe(),
          () => backend.listCandidates('checkpoint'),
          () => backend.generate(request, new AbortController().signal),
        ];
        for (const call of calls) {
          const error: unknown = await call().then(
            () => undefined,
            (e: unknown) => e,
          );
          expect(error).toBeInstanceOf(BackendError);
          expect((error as BackendError).kind).toBe('unreachable');
        }
      });
    });
  });
}
