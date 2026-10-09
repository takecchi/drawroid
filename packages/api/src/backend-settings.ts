import { z } from 'zod';

// 画面に返す形。パスワードは型にも持たせない: 秘密を UI に出さないため（PRD）
export const backendSettingsViewSchema = z.object({
  forgeUrl: z.string(),
  // 'cli' のときは、次の起動で --forge-url が config.json より勝つ
  forgeUrlSource: z.enum(['cli', 'config', 'default']),
  auth: z.object({ username: z.string() }).nullable(),
  generateTimeoutMs: z.number().nullable(),
});
export type BackendSettingsView = z.infer<typeof backendSettingsViewSchema>;

// API で変えるのは URL だけ: auth と generateTimeoutMs は config.json を手で書く（秘密を HTTP で受け取らない）
export const updateBackendSettingsSchema = z.object({
  forgeUrl: z.url({ protocol: /^https?$/ }),
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
