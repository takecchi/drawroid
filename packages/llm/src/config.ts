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

export const roleConfigSchema = z.object({
  /** providers の鍵 */
  provider: z.string().min(1),
  model: z.string().min(1),
  contextTokens: z.number().int().positive().default(8192),
  maxOutputTokens: z.number().int().positive().default(1024),
  structuredOutput: structuredOutputModeSchema.default('native'),
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
    }),
    /** スキーマに合わない出力を出し直させる回数 */
    validationRetries: z.number().int().min(0).default(2),
    /** 繋がらない・429 などのときに AI SDK が呼び直す回数 */
    networkRetries: z.number().int().min(0).default(2),
  })
  .superRefine((config, ctx) => {
    for (const role of ['think', 'judge'] as const) {
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

export type ResolvedRoles = { think: RoleConfig; judge: RoleConfig };

export function resolveRoles(config: LlmConfig): ResolvedRoles {
  return { think: config.roles.think, judge: config.roles.judge ?? config.roles.think };
}
