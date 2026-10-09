import { z } from 'zod';

// API キーの値を設定に置かせない（apiKey を書いたら strict で落とす）: 設定は API の応答と画面に出るため
const apiKeyFields = {
  /** API キーを入れた環境変数の名前 */
  apiKeyEnv: z.string().min(1).optional(),
};

export const providerConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('openai-compatible'), baseURL: z.url(), ...apiKeyFields }).strict(),
  z.object({ type: z.literal('openai'), baseURL: z.url().optional(), ...apiKeyFields }).strict(),
  z.object({ type: z.literal('anthropic'), baseURL: z.url().optional(), ...apiKeyFields }).strict(),
]);
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

/**
 * 構造化出力の出し方。
 * - native: JSON Schema をモデルへ渡す（対応している provider・モデルで使う）
 * - json: JSON を出すことだけを指定し、スキーマは指示文で伝える
 * - text: 指定せず、スキーマを指示文で伝えて、テキストから JSON を取り出す
 * どれでも、最後は core のスキーマで検証する。
 */
export const structuredOutputModeSchema = z.enum(['native', 'json', 'text']);
export type StructuredOutputMode = z.infer<typeof structuredOutputModeSchema>;

/**
 * モデルが出す思考（reasoning）の受け取り方。
 * - native: provider が分けて返す思考を使う（OpenAI 互換の reasoning_content・reasoning など）
 * - think-tag: 本文に混ざる <think>…</think> を思考として切り出す（Qwen 系など）
 * - none: 思考を受け取らない（画面にも出さない）
 * どれでも、思考は次の入力に戻さない。
 */
export const reasoningModeSchema = z.enum(['native', 'think-tag', 'none']);
export type ReasoningMode = z.infer<typeof reasoningModeSchema>;

export const roleConfigSchema = z.object({
  /** providers の鍵 */
  provider: z.string().min(1),
  model: z.string().min(1),
  /** 省略したら provider が報告する窓の長さを読む（detectContextTokens）。読めなければ既定の窓を使う */
  contextTokens: z.number().int().positive().optional(),
  /** 省略したら上限を送らず、provider 側の設定に任せる */
  maxOutputTokens: z.number().int().positive().optional(),
  structuredOutput: structuredOutputModeSchema.default('native'),
  reasoning: reasoningModeSchema.default('native'),
  imageInput: z.boolean().default(true),
});
export type RoleConfig = z.infer<typeof roleConfigSchema>;

export const llmConfigSchema = z
  .object({
    providers: z.record(z.string(), providerConfigSchema),
    roles: z.object({
      think: roleConfigSchema,
      /** 省略したら考える役と同じモデルを使う */
      judge: roleConfigSchema.optional(),
      /** 会話で人間と話す役（ツールを呼ぶ）。省略したら考える役と同じモデルを使う */
      talk: roleConfigSchema.optional(),
    }),
    /** スキーマに合わない出力を出し直させる回数 */
    validationRetries: z.number().int().min(0).default(2),
    /** 繋がらない・429 などのときに AI SDK が呼び直す回数 */
    networkRetries: z.number().int().min(0).default(2),
  })
  .superRefine((config, ctx) => {
    for (const role of ['think', 'judge', 'talk'] as const) {
      const provider = config.roles[role]?.provider;
      if (provider !== undefined && !(provider in config.providers)) {
        ctx.addIssue({
          code: 'custom',
          path: ['roles', role, 'provider'],
          message: `provider「${provider}」が providers に無い`,
        });
      }
    }
  });
export type LlmConfig = z.infer<typeof llmConfigSchema>;

export type ResolvedRoles = { think: RoleConfig; judge: RoleConfig; talk: RoleConfig };

export function resolveRoles(config: LlmConfig): ResolvedRoles {
  return {
    think: config.roles.think,
    judge: config.roles.judge ?? config.roles.think,
    talk: config.roles.talk ?? config.roles.think,
  };
}
