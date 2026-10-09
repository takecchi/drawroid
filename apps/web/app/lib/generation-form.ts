import type { GenerationRequestInput } from '@drawroid/core';

// 入力欄の値は、すべて文字列で持つ: 数値の欄を number で持つと、入力途中の空欄や「-」を表せないため
export interface GenerationFormValues {
  prompt: string;
  negativePrompt: string;
  checkpoint: string;
  vae: string;
  sampler: string;
  scheduler: string;
  loras: { name: string; weight: string }[];
  steps: string;
  cfgScale: string;
  width: string;
  height: string;
  seed: string;
  batchSize: string;
}

export const DEFAULT_FORM_VALUES: GenerationFormValues = {
  prompt: '',
  negativePrompt: '',
  checkpoint: '',
  vae: '',
  sampler: '',
  scheduler: '',
  loras: [],
  steps: '20',
  cfgScale: '7',
  width: '512',
  height: '512',
  seed: '',
  batchSize: '1',
};

export const DEFAULT_LORA_WEIGHT = '1';

// 数値に直せない文字列は NaN のまま渡す: 黙って省くと、seed の打ち間違いが「ランダム」に化けるため。サーバの検証が 400 で理由を返す
function toNumber(text: string): number {
  return Number(text.trim());
}

export function buildGenerationRequest(values: GenerationFormValues): GenerationRequestInput {
  const request: GenerationRequestInput = {
    prompt: values.prompt,
    steps: toNumber(values.steps),
    cfgScale: toNumber(values.cfgScale),
    width: toNumber(values.width),
    height: toNumber(values.height),
  };
  const optionalText = {
    negativePrompt: values.negativePrompt,
    checkpoint: values.checkpoint,
    sampler: values.sampler,
    scheduler: values.scheduler,
  };
  for (const [key, value] of Object.entries(optionalText)) {
    if (value.trim() !== '') Object.assign(request, { [key]: value });
  }
  if (values.seed.trim() !== '') request.seed = toNumber(values.seed);
  if (values.batchSize.trim() !== '') request.batchSize = toNumber(values.batchSize);
  if (values.loras.length > 0) {
    request.loras = values.loras.map(({ name, weight }) => ({
      name,
      weight: toNumber(weight.trim() === '' ? DEFAULT_LORA_WEIGHT : weight),
    }));
  }
  return request;
}
