import type { BackendFeature, GenerationRequest } from '../backend.js';

// batchSize は AI に許す対象にしない: 1回に何枚出すかは「見る」に載せる画像の枚数の予算で決まるため
type RequestParamKey = Exclude<keyof GenerationRequest, 'batchSize'>;
// img2img・inpaint・controlnet は、GenerationRequest に欄が入るまで（M4）能力の名前で表す
type FeatureParamKey = Exclude<BackendFeature, 'hiresFix'>;

export type ParamKey = RequestParamKey | FeatureParamKey;

// Record で書くのは、GenerationRequest に欄が増えたときに、ここが型の上で足りなくなるようにするため
const PARAM_KEY_SET: Record<ParamKey, true> = {
  prompt: true,
  negativePrompt: true,
  checkpoint: true,
  vae: true,
  loras: true,
  sampler: true,
  scheduler: true,
  steps: true,
  cfgScale: true,
  seed: true,
  width: true,
  height: true,
  hiresFix: true,
  img2img: true,
  inpaint: true,
  controlnet: true,
};

export const PARAM_KEYS = Object.keys(PARAM_KEY_SET) as readonly ParamKey[];
