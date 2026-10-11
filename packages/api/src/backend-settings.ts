import { z } from 'zod';

// 繋ぐ先の種類。起動時は config.json と CLI 引数で、起動後は設定の API で選ぶ
export const backendKindSchema = z.enum(['forge', 'a1111']);
export type BackendKind = z.infer<typeof backendKindSchema>;

// 画面に返す形。パスワードは型にも持たせない: 秘密を UI に出さないため（PRD）
export const backendSettingsViewSchema = z.object({
  kind: backendKindSchema,
  url: z.string(),
  // いま使っている URL をどこから得たか。保存すれば 'config' になる。次の起動で引数が勝つかは startupArgs を見る
  urlSource: z.enum(['cli', 'config', 'default']),
  // いま使っている種類をどこから得たか。保存すれば 'config' になる。次の起動で引数が勝つかは startupArgs を見る
  kindSource: z.enum(['cli', 'config', 'default']),
  // 起動の引数（--backend / --backend-url）が付いて起動したか。true のあいだは、保存してもいまの起動中だけ効き、次の起動では引数が config.json より勝つ。起動のあいだは変わらない
  startupArgs: z.object({ kind: z.boolean(), url: z.boolean() }),
  auth: z.object({ username: z.string() }).nullable(),
  generateTimeoutMs: z.number().nullable(),
});
export type BackendSettingsView = z.infer<typeof backendSettingsViewSchema>;

// API で変えるのは URL と種類だけ: auth と generateTimeoutMs は config.json を手で書く（秘密を HTTP で受け取らない）。
// どちらも省けるが、省いたほうは、いま使っている値のまま config.json にも触れない（触っていない値を書くと、--backend などの引数で起動した値が config.json に残り、次の起動が変わるため）。両方を省いた body は受けない
export const updateBackendSettingsSchema = z
  .object({
    url: z
      .url({ protocol: /^https?$/, error: 'URL は http:// か https:// で始まる形で書く' })
      .optional(),
    kind: backendKindSchema.optional(),
  })
  .refine(({ url, kind }) => url !== undefined || kind !== undefined, {
    message: 'url か kind の少なくとも一方が要る',
  });
export type UpdateBackendSettings = z.infer<typeof updateBackendSettingsSchema>;

/** 生成が走っているあいだは繋ぎ直せないことを表す。API は 409 で返す */
export class BackendBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackendBusyError';
  }
}

export interface BackendSettingsPort {
  read(): Promise<BackendSettingsView>;
  /** 生成が走っていれば BackendBusyError を投げ、config.json も書かない */
  write(input: UpdateBackendSettings): Promise<BackendSettingsView>;
}
