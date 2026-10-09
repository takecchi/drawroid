import { describe, expect, it } from 'vitest';

import {
  BACKEND_FEATURES,
  CANDIDATE_KIND_FEATURE,
  CANDIDATE_KINDS,
  candidateSchema,
  generationRequestSchema,
  type ImageBackend,
} from '../backend.js';
import { BackendError } from '../backend-error.js';
import { STUB_PNG } from './stub-backend.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface ContractBackend {
  backend: ImageBackend;
  close?: () => Promise<void>;
}

export interface ImageBackendContractTarget {
  // 正常に繋がるバックエンド。使える機能の候補は、種類ごとに1件以上持たせること
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

    it('reports limits as positive whole numbers when it reports them', async () => {
      await withBackend(target.connected, async (backend) => {
        const { limits } = await backend.probe();
        for (const value of Object.values(limits ?? {})) {
          expect(Number.isInteger(value) && value > 0).toBe(true);
        }
      });
    });

    it('lists candidates of every kind whose feature is available', async () => {
      await withBackend(target.connected, async (backend) => {
        const unavailable = new Set((await backend.probe()).unavailable.map((u) => u.feature));
        for (const kind of CANDIDATE_KINDS) {
          const candidates = await backend.listCandidates(kind);
          const feature = CANDIDATE_KIND_FEATURE[kind];
          if (feature === undefined || !unavailable.has(feature)) {
            expect(candidates.length, kind).toBeGreaterThan(0);
          }
          for (const candidate of candidates) candidateSchema.parse(candidate);
        }
      });
    });

    it('refuses to generate when the content of a referenced image is not passed', async () => {
      await withBackend(target.connected, async (backend) => {
        const withSource = generationRequestSchema.parse({
          ...request,
          img2img: { image: 'iterations/0001/images/0.png', denoisingStrength: 0.5 },
        });
        await expect(
          backend.generate(withSource, new AbortController().signal, new Map()),
        ).rejects.toMatchObject({ name: 'BackendError', kind: 'failed' });
      });
    });

    // ImageBackend.generate の TSDoc「足りなければ失敗する」: 一部だけ渡されたときも通さない
    it('refuses to generate when only some of the referenced images are passed', async () => {
      await withBackend(target.connected, async (backend) => {
        const source = 'iterations/0001/images/0.png';
        const withMask = generationRequestSchema.parse({
          ...request,
          inpaint: { image: source, mask: 'masks/m1.png', denoisingStrength: 0.5 },
        });
        const onlySource = new Map([[source, { data: STUB_PNG, mediaType: 'image/png' as const }]]);
        await expect(
          backend.generate(withMask, new AbortController().signal, onlySource),
        ).rejects.toMatchObject({ name: 'BackendError', kind: 'failed' });
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

    it('reports nothing running from progress, when it has one, while idle', async () => {
      await withBackend(target.connected, async (backend) => {
        if (backend.progress === undefined) return;
        expect(await backend.progress(new AbortController().signal)).toBeUndefined();
      });
    });

    it('reports an unreachable backend as unreachable on every call', async () => {
      await withBackend(target.unreachable, async (backend) => {
        const calls = [
          () => backend.probe(),
          () => backend.listCandidates('checkpoint'),
          () => backend.generate(request, new AbortController().signal),
          // progress は任意: 持つ backend だけ、繋がらないことを同じ種類で返す
          ...(backend.progress === undefined
            ? []
            : [async () => backend.progress?.(new AbortController().signal)]),
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
