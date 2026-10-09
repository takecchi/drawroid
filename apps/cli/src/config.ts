import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { backendKindSchema, type BackendKind } from '@drawroid/api';
import { z } from 'zod';

// Forge も A1111 も既定で 7860 を待ち受けるので、種類に依らず同じ既定を使う
export const DEFAULT_FORGE_URL = 'http://127.0.0.1:7860';
export const DEFAULT_BACKEND_KIND: BackendKind = 'forge';

const configSchema = z.object({
  backend: z
    .object({
      kind: backendKindSchema.optional(),
      forgeUrl: z.url().optional(),
      auth: z.object({ username: z.string(), password: z.string() }).optional(),
      generateTimeoutMs: z.number().int().positive().optional(),
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
export function resolveForgeUrlWithSource(
  cliArg: string | undefined,
  config: Config,
): { forgeUrl: string; source: 'cli' | 'config' | 'default' } {
  if (cliArg !== undefined) return { forgeUrl: cliArg, source: 'cli' };
  if (config.backend?.forgeUrl !== undefined) {
    return { forgeUrl: config.backend.forgeUrl, source: 'config' };
  }
  return { forgeUrl: DEFAULT_FORGE_URL, source: 'default' };
}

// 優先順位は URL と同じく CLI 引数 > config.json > 既定
export function resolveBackendKind(cliArg: BackendKind | undefined, config: Config): BackendKind {
  return cliArg ?? config.backend?.kind ?? DEFAULT_BACKEND_KIND;
}

export function resolveForgeUrl(cliArg: string | undefined, config: Config): string {
  return resolveForgeUrlWithSource(cliArg, config).forgeUrl;
}
