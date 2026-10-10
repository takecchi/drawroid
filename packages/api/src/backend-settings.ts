import { z } from 'zod';

// 繋ぐ先の種類。起動時は config.json と CLI 引数で、起動後は設定の API で選ぶ
export const backendKindSchema = z.enum(['forge', 'a1111']);
export type BackendKind = z.infer<typeof backendKindSchema>;

// 画面に返す形。パスワードは型にも持たせない: 秘密を UI に出さないため（PRD）
export const backendSettingsViewSchema = z.object({
  kind: backendKindSchema,
  url: z.string(),
  // 'cli' のときは、次の起動で --backend-url（古い名前 --forge-url）が config.json より勝つ
  urlSource: z.enum(['cli', 'config', 'default']),
  // 'cli' のときは、次の起動で --backend が config.json より勝つ
  kindSource: z.enum(['cli', 'config', 'default']),
  auth: z.object({ username: z.string() }).nullable(),
  generateTimeoutMs: z.number().nullable(),
});
export type BackendSettingsView = z.infer<typeof backendSettingsViewSchema>;

// API で変えるのは URL と種類だけ: auth と generateTimeoutMs は config.json を手で書く（秘密を HTTP で受け取らない）。種類を省けば、いま使っている種類のまま
export const updateBackendSettingsSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  kind: backendKindSchema.optional(),
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
