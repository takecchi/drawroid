import { z } from 'zod';

// 画像生成バックエンドのポート。Forge / A1111 / ComfyUI の違いはアダプタ（packages/backend-*）の中に閉じ、ここにはバックエンドを問わない形だけを置く

export const CANDIDATE_KINDS = ['checkpoint', 'vae', 'lora', 'sampler', 'scheduler'] as const;
export const candidateKindSchema = z.enum(CANDIDATE_KINDS);
export type CandidateKind = z.infer<typeof candidateKindSchema>;

export const candidateSchema = z.object({
  // GenerationRequest に書く値。アダプタはこの値でバックエンドの候補を引き当てられること
  name: z.string().min(1),
  // 人間に見せるための表示名。name と同じなら省く
  label: z.string().optional(),
});
export type Candidate = z.infer<typeof candidateSchema>;

export const loraSchema = z.object({
  name: z.string().min(1),
  weight: z.number(),
});

export const hiresFixSchema = z.object({
  upscaler: z.string().min(1),
  scale: z.number().positive(),
  steps: z.number().int().nonnegative(),
  denoisingStrength: z.number().min(0).max(1),
});

// 省いた欄はバックエンドの既定に任せる。img2img・inpaint・ControlNet は M4 で欄を足す
export const generationRequestSchema = z.object({
  prompt: z.string(),
  negativePrompt: z.string().default(''),
  checkpoint: z.string().min(1).optional(),
  vae: z.string().min(1).optional(),
  loras: z.array(loraSchema).default([]),
  sampler: z.string().min(1).optional(),
  scheduler: z.string().min(1).optional(),
  steps: z.number().int().positive(),
  cfgScale: z.number().positive(),
  // 省いたらバックエンドが乱数で決め、実際の値を GeneratedImage.seed で返す
  seed: z.number().int().nonnegative().optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  batchSize: z.number().int().positive().default(1),
  hiresFix: hiresFixSchema.optional(),
});
export type GenerationRequest = z.infer<typeof generationRequestSchema>;
export type GenerationRequestInput = z.input<typeof generationRequestSchema>;

export interface GeneratedImage {
  png: Uint8Array;
  // 実際に使われた seed。バックエンドが返さないときは null
  seed: number | null;
  // バックエンドがこの画像について返したメタデータ。中身の形はバックエンドごとに違うので、core は読まずに保存と表示だけに使う
  metadata: Record<string, unknown>;
}

export interface GenerationResult {
  images: GeneratedImage[];
  metadata: Record<string, unknown>;
}

export const BACKEND_FEATURES = ['hiresFix', 'img2img', 'inpaint', 'controlnet'] as const;
export type BackendFeature = (typeof BACKEND_FEATURES)[number];

export interface BackendCapabilities {
  // 使えない機能とその理由。core は、ここにある機能を「使わない」と同じに扱って選択肢から外し、理由を UI に出す
  unavailable: { feature: BackendFeature; reason: string }[];
}

export interface ImageBackend {
  probe(signal?: AbortSignal): Promise<BackendCapabilities>;
  listCandidates(kind: CandidateKind, signal?: AbortSignal): Promise<Candidate[]>;
  generate(req: GenerationRequest, signal: AbortSignal): Promise<GenerationResult>;
  // 走っている生成をバックエンド側で止める。signal の abort は HTTP の待ちを切るだけで、GPU は回り続けるため
  interrupt(): Promise<void>;
}
