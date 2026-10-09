import { z } from 'zod';

// 繋ぐ先の種類。選ぶのは config.json と CLI 引数で、API では変えさせない
export const backendKindSchema = z.enum(['forge', 'a1111']);
export type BackendKind = z.infer<typeof backendKindSchema>;

// 画面に返す形。パスワードは型にも持たせない: 秘密を UI に出さないため（PRD）
export const backendSettingsViewSchema = z.object({
  kind: backendKindSchema,
  // 種類が A1111 でも、この名前で A1111 の URL を表す（改名は別の PR）
  forgeUrl: z.string(),
  // 'cli' のときは、次の起動で --forge-url が config.json より勝つ
  forgeUrlSource: z.enum(['cli', 'config', 'default']),
  auth: z.object({ username: z.string() }).nullable(),
  generateTimeoutMs: z.number().nullable(),
});
export type BackendSettingsView = z.infer<typeof backendSettingsViewSchema>;

// API で変えるのは URL だけ: auth と generateTimeoutMs は config.json を手で書く（秘密を HTTP で受け取らない）。種類は繋ぎ直しで作り分けると試験の面が広がるので、M6 では config.json と CLI 引数だけで選ぶ
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
