import { parseArgs } from 'node:util';

import { backendKindSchema, type BackendKind } from '@drawroid/api';

import { DEFAULT_PORT } from './listen.js';

export interface CliOptions {
  port: number;
  dataDir: string | undefined;
  backend: BackendKind | undefined;
  forgeUrl: string | undefined;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      'data-dir': { type: 'string' },
      backend: { type: 'string' },
      'forge-url': { type: 'string' },
    },
    strict: true,
  });
  return {
    port: parsePort(values.port),
    dataDir: values['data-dir'],
    backend: parseBackend(values.backend),
    forgeUrl: values['forge-url'],
  };
}

function parseBackend(raw: string | undefined): BackendKind | undefined {
  if (raw === undefined) return undefined;
  const parsed = backendKindSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `--backend は ${backendKindSchema.options.join(' か ')} で指定する（受け取った値: ${raw}）`,
    );
  }
  return parsed.data;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--port は 1〜65535 の整数で指定する（受け取った値: ${raw}）`);
  }
  return port;
}
