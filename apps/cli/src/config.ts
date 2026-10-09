import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { z } from 'zod';

export const DEFAULT_FORGE_URL = 'http://127.0.0.1:7860';

const configSchema = z.object({
  backend: z
    .object({
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
export function resolveForgeUrl(cliArg: string | undefined, config: Config): string {
  return cliArg ?? config.backend?.forgeUrl ?? DEFAULT_FORGE_URL;
}
