import { BackendError, type GenerationRequest } from '@drawroid/core';

/** プロンプトの後ろに、LoRA を `<lora:名前:重み>` のタグで足す */
export function withLoras(prompt: string, loras: GenerationRequest['loras']): string {
  if (loras.length === 0) return prompt;
  for (const lora of loras) {
    if (/[:<>]/.test(lora.name)) {
      throw new BackendError(
        'failed',
        `LoRA の名前に : < > を含むものは指定できない: ${lora.name}`,
      );
    }
  }
  // 3つ目の値が UNet の重みになる（Forge の sd_forge_lora/extra_networks_lora.py）
  const tags = loras
    .map((l) =>
      l.unetWeight === undefined
        ? `<lora:${l.name}:${l.weight}>`
        : `<lora:${l.name}:${l.weight}:${l.unetWeight}>`,
    )
    .join(' ');
  return prompt === '' ? tags : `${prompt} ${tags}`;
}
