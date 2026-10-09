import { generationRequestSchema, type GenerationRequest } from '../backend.js';
import { PARAM_KEYS } from '../params/param-key.js';
import type { Permissions } from './permission.js';

/**
 * 考える役の決定から、バックエンドに渡す生成の依頼を組み立てる。生成の直前に呼ぶ。
 * 「AI に任せる」パラメータだけ AI の値を使い、「固定」は人間の値で上書きし、「使わない」は渡さない。
 */
// 出力スキーマで許可を絞ってあっても、ここでもう一度当てる: 固定の値を守るのが出力スキーマだけだと、
// スキーマの組み立てを誤った・検証を通らない値が紛れた、のどちらでも AI の値で生成されてしまうため
export function toGenerationRequest(args: {
  decided: Readonly<Record<string, unknown>>;
  permissions: Permissions;
  batchSize: number;
}): GenerationRequest {
  const { decided, permissions, batchSize } = args;
  const request: Record<string, unknown> = { batchSize };
  for (const key of PARAM_KEYS) {
    const permission = permissions[key];
    if (permission.mode === 'fixed') request[key] = permission.value;
    else if (permission.mode === 'auto' && decided[key] !== undefined) request[key] = decided[key];
  }
  return generationRequestSchema.parse(request);
}
