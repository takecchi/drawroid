import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { backendKindSchema, type BackendKind } from '@drawroid/api';
import { z } from 'zod';

// Forge も A1111 も既定で 7860 を待ち受けるので、種類に依らず同じ既定を使う
export const DEFAULT_BACKEND_URL = 'http://127.0.0.1:7860';
export const DEFAULT_BACKEND_KIND: BackendKind = 'forge';

const configSchema = z.object({
  backend: z
    .object({
      kind: backendKindSchema.optional(),
      url: z.url().optional(),
      // 古い名前。読むだけで、書くときは url にする
      forgeUrl: z.url().optional(),
      auth: z.object({ username: z.string(), password: z.string() }).optional(),
      generateTimeoutMs: z.number().int().positive().optional(),
    })
    // 両方あるときは断る: どちらを使ったかが読み手に分からなくなるため
    .refine((backend) => backend.url === undefined || backend.forgeUrl === undefined, {
      message: 'backend の url と forgeUrl（古い名前）が両方ある。url だけにする',
    })
    .transform(({ forgeUrl, ...backend }) => {
      const url = backend.url ?? forgeUrl;
      return { ...backend, ...(url !== undefined && { url }) };
    })
    .optional(),
});
export type Config = z.infer<typeof configSchema>;

export async function readConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const name = basename(path);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${name} が JSON として読めない: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) throw new Error(`${name} の形が違う: ${parsed.error.message}`);
  return parsed.data;
}

// 優先順位は CLI 引数 > config.json > 既定
export function resolveBackendUrlWithSource(
  cliArg: string | undefined,
  config: Config,
): { url: string; source: 'cli' | 'config' | 'default' } {
  if (cliArg !== undefined) return { url: cliArg, source: 'cli' };
  if (config.backend?.url !== undefined) return { url: config.backend.url, source: 'config' };
  return { url: DEFAULT_BACKEND_URL, source: 'default' };
}

// 優先順位は URL と同じく CLI 引数 > config.json > 既定
export function resolveBackendKind(cliArg: BackendKind | undefined, config: Config): BackendKind {
  return cliArg ?? config.backend?.kind ?? DEFAULT_BACKEND_KIND;
}

export function resolveBackendUrl(cliArg: string | undefined, config: Config): string {
  return resolveBackendUrlWithSource(cliArg, config).url;
}
