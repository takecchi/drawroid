import { z } from 'zod';

// 画像生成バックエンドのポート。Forge / A1111 / ComfyUI の違いはアダプタ（packages/backend-*）の中に閉じ、ここにはバックエンドを問わない形だけを置く

export const CANDIDATE_KINDS = [
  'checkpoint',
  'vae',
  'lora',
  'sampler',
  'scheduler',
  // Hires. fix の拡大の方式
  'upscaler',
  'controlnetModel',
  // ControlNet の前処理。省けば、画像をそのまま制御に使う
  'controlnetModule',
] as const;
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
  // テキストエンコーダへの重み。unetWeight を省けば UNet にも同じ重みを使う
  weight: z.number(),
  unetWeight: z.number().optional(),
});

// 省いた欄は一段目と同じ値を使う
export const hiresFixSchema = z.object({
  upscaler: z.string().min(1),
  scale: z.number().positive(),
  // 0 は一段目と同じ steps
  steps: z.number().int().nonnegative(),
  denoisingStrength: z.number().min(0).max(1),
  checkpoint: z.string().min(1).optional(),
  sampler: z.string().min(1).optional(),
  scheduler: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  negativePrompt: z.string().optional(),
  cfgScale: z.number().positive().optional(),
});

/**
 * データディレクトリの中の画像を指す参照。形（image:<回>-<画像>・ref:<refId>・mask:<maskId>）は core の loop/image-sources が決めて読み、アダプタは中を読まない。
 * 中身は generate の images で渡す。生成した画像だけでなく、人間が添えた参照画像・塗ったマスクも指すので、
 * job/store の ImageRef（生成した画像の位置）とは別の型にしてある。
 */
// 要求に画像の中身を入れない: 要求は request.json としてそのまま残すので、原寸の画像が JSON に埋まるため
export const inputImageRefSchema = z.string().min(1);
export type InputImageRef = z.infer<typeof inputImageRefSchema>;

/** 元画像をどう生成の大きさに合わせるか。stretch = 縦横比を変えて合わせる / crop = はみ出しを切る / fill = 足りない所を埋める */
export const RESIZE_MODES = ['stretch', 'crop', 'fill'] as const;
export const resizeModeSchema = z.enum(RESIZE_MODES);
export type ResizeMode = z.infer<typeof resizeModeSchema>;

export const img2imgSchema = z.object({
  image: inputImageRefSchema,
  denoisingStrength: z.number().min(0).max(1),
  resize: resizeModeSchema.default('stretch'),
});

/** マスクの塗る所の埋め方。original = 元の画像のまま / fill = 周りの色でぼかす / latentNoise・latentNothing = 潜在空間でノイズ・無で埋める */
export const INPAINT_FILLS = ['original', 'fill', 'latentNoise', 'latentNothing'] as const;

// 既定は Forge・A1111 の画面の既定に揃える。API の既定（fill・masked）は画面と違い、人間が画面で試した結果と食い違うため
export const inpaintSchema = z.object({
  // マスクを塗った画像。マスクはこの画像に紐づく（Issue #5 の H）
  image: inputImageRefSchema,
  // 白い所を描き直す
  mask: inputImageRefSchema,
  denoisingStrength: z.number().min(0).max(1),
  maskBlur: z.number().int().nonnegative().default(4),
  fill: z.enum(INPAINT_FILLS).default('original'),
  // whole = 画像全体を描き直す / masked = 塗った所の周りだけを拡大して描き直す
  area: z.enum(['whole', 'masked']).default('whole'),
  // area が masked のとき、塗った所の周りに含める余白（px）
  padding: z.number().int().nonnegative().default(32),
  resize: resizeModeSchema.default('stretch'),
});

/** 制御の効かせ方。prompt = プロンプトを重く / controlnet = 制御を重く */
export const CONTROL_MODES = ['balanced', 'prompt', 'controlnet'] as const;

export const controlNetUnitSchema = z
  .object({
    image: inputImageRefSchema,
    // 省けば前処理をせず、image をそのまま制御に使う（すでに線画・深度などになっている画像）
    module: z.string().min(1).optional(),
    model: z.string().min(1),
    weight: z.number().min(0).default(1),
    guidanceStart: z.number().min(0).max(1).default(0),
    guidanceEnd: z.number().min(0).max(1).default(1),
    controlMode: z.enum(CONTROL_MODES).default('balanced'),
    resize: resizeModeSchema.default('crop'),
    pixelPerfect: z.boolean().default(false),
  })
  .refine((unit) => unit.guidanceStart <= unit.guidanceEnd, {
    message: 'guidanceStart は guidanceEnd 以下にする',
    path: ['guidanceStart'],
  });
export type ControlNetUnit = z.infer<typeof controlNetUnitSchema>;

// 省いた欄はバックエンドの既定に任せる
export const generationRequestSchema = z
  .object({
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
    // 欄の名前は BackendFeature に揃える: 許可（ParamKey）と能力（BackendCapabilities）を同じ名前で引くため
    img2img: img2imgSchema.optional(),
    inpaint: inpaintSchema.optional(),
    controlnet: z.array(controlNetUnitSchema).default([]),
  })
  // inpaint は元画像とマスクを持つ img2img なので、両方を同時には指定しない
  .refine((req) => req.img2img === undefined || req.inpaint === undefined, {
    message: 'img2img と inpaint は同時に指定しない（inpaint は元画像を持つ）',
    path: ['inpaint'],
  });
export type GenerationRequest = z.infer<typeof generationRequestSchema>;
export type GenerationRequestInput = z.input<typeof generationRequestSchema>;

/** 要求が指している画像の参照。呼び出し側は、これらの中身を generate の images で渡す */
export function inputImageRefsOf(req: GenerationRequest): InputImageRef[] {
  const refs = [
    req.img2img?.image,
    req.inpaint?.image,
    req.inpaint?.mask,
    ...req.controlnet.map((unit) => unit.image),
  ].filter((ref): ref is InputImageRef => ref !== undefined);
  return [...new Set(refs)];
}

/** generate に渡す画像の中身 */
export interface InputImage {
  data: Uint8Array;
  mediaType: string;
}
export type GenerationImages = ReadonlyMap<InputImageRef, InputImage>;

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

/** 機能に属する候補の種類。その機能が使えないバックエンドでは、候補が空でよい */
export const CANDIDATE_KIND_FEATURE: Partial<Record<CandidateKind, BackendFeature>> = {
  upscaler: 'hiresFix',
  controlnetModel: 'controlnet',
  controlnetModule: 'controlnet',
};

export interface BackendLimits {
  // 1回の生成に載せられる ControlNet のユニットの数
  controlnetUnits?: number;
}

export interface BackendCapabilities {
  // 使えない機能とその理由。core は、ここにある機能を「使わない」と同じに扱って選択肢から外し、理由を UI に出す
  unavailable: { feature: BackendFeature; reason: string }[];
  // 使える機能の上限。省いた上限は無いものとみなす
  limits?: BackendLimits;
}

export interface GenerationProgress {
  // 0〜1
  fraction: number;
  // 取れないバックエンドでは null
  step: number | null;
  steps: number | null;
  etaSeconds: number | null;
  // includePreview を true にして、バックエンドが途中の画像を持っているときだけ付く
  preview?: { data: Uint8Array; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' };
}

export interface ImageBackend {
  probe(signal?: AbortSignal): Promise<BackendCapabilities>;
  listCandidates(kind: CandidateKind, signal?: AbortSignal): Promise<Candidate[]>;
  /** images には、inputImageRefsOf(req) のすべての参照の中身を入れる。足りなければ失敗する */
  generate(
    req: GenerationRequest,
    signal: AbortSignal,
    images?: GenerationImages,
  ): Promise<GenerationResult>;
  // 走っている生成をバックエンド側で止める。signal の abort は HTTP の待ちを切るだけで、GPU は回り続けるため
  interrupt(): Promise<void>;
  /**
   * 走っている生成の進み具合を返す。何も走っていなければ undefined。
   *
   * 任意のメソッド: 持たないアダプタは実装しない（その場合、画面は「生成中」とだけ出す）。
   * 進み具合はファイルに書かない（生成が終われば job.images が確定するため）。
   * LLM は通さない（トークンを使わず、バックエンドの HTTP を読むだけ）。
   */
  progress?(
    signal: AbortSignal,
    options?: { includePreview?: boolean },
  ): Promise<GenerationProgress | undefined>;
}
