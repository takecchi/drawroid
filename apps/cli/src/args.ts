import { parseArgs } from 'node:util';

import { backendKindSchema, type BackendKind } from '@drawroid/api';

import { DEFAULT_PORT } from './listen.js';

/** 何をするか。省けば待ち受けを始める。doctor は、実機で試す前に設定と繋がりを一度に確かめて終わる */
export type CliCommand = 'serve' | 'doctor';

export interface CliOptions {
  command: CliCommand;
  port: number;
  dataDir: string | undefined;
  backend: BackendKind | undefined;
  backendUrl: string | undefined;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      'data-dir': { type: 'string' },
      backend: { type: 'string' },
      'backend-url': { type: 'string' },
      // 古い名前。--backend-url と同じ意味で受ける
      'forge-url': { type: 'string' },
    },
    strict: true,
    allowPositionals: true,
  });
  return {
    command: parseCommand(positionals),
    port: parsePort(values.port),
    dataDir: values['data-dir'],
    backend: parseBackend(values.backend),
    backendUrl: parseBackendUrl(values['backend-url'], values['forge-url']),
  };
}

function parseCommand(positionals: string[]): CliCommand {
  const [first, ...rest] = positionals;
  if (first === undefined) return 'serve';
  if (first === 'doctor' && rest.length === 0) return 'doctor';
  throw new Error(`知らない指定: ${positionals.join(' ')}（使えるのは doctor だけ）`);
}

function parseBackendUrl(
  backendUrl: string | undefined,
  forgeUrl: string | undefined,
): string | undefined {
  if (backendUrl !== undefined && forgeUrl !== undefined) {
    throw new Error('--backend-url と --forge-url（古い名前）は片方だけを指定する');
  }
  return backendUrl ?? forgeUrl;
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
