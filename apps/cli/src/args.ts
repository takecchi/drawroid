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

const OPTIONS = {
  port: { type: 'string' },
  'data-dir': { type: 'string' },
  backend: { type: 'string' },
  'backend-url': { type: 'string' },
  // 古い名前。--backend-url と同じ意味で受ける
  'forge-url': { type: 'string' },
} as const;

const USABLE =
  '使えるのは doctor と --port・--data-dir・--backend・--backend-url（古い名前 --forge-url）';

export function parseCliArgs(argv: string[]): CliOptions {
  const { values, positionals } = parseKnownArgs(argv);
  return {
    command: parseCommand(positionals),
    port: parsePort(values.port),
    dataDir: values['data-dir'],
    backend: parseBackend(values.backend),
    backendUrl: parseBackendUrl(values['backend-url'], values['forge-url']),
  };
}

// node の文をそのまま出さない: 英語のうえ、「-- のあとに置け」と、この CLI では落ちる書き方を勧めるため
function parseKnownArgs(argv: string[]) {
  // -- のあとは parseArgs が指定ではなく語として受けるので、先に断る。そのままだと「知らない指定: --port …
  // （使えるのは doctor だけ）」となり、使える --port まで使えないように読める（pnpm drawroid -- --port … で踏む）
  const separator = argv.indexOf('--');
  if (separator !== -1) {
    const intended = [...argv.slice(0, separator), ...argv.slice(separator + 1)].join(' ');
    throw new Error(
      `-- を挟まずに打つ（例: pnpm drawroid ${intended === '' ? '--port 7878' : intended}）。-- のあとの指定は受け取らない`,
    );
  }
  try {
    return parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: true });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const option = error instanceof Error ? /'(-[^' ]+)/.exec(error.message)?.[1] : undefined;
    if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      throw new Error(`知らない指定: ${option ?? argv.join(' ')}（${USABLE}）`, { cause: error });
    }
    if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      throw new Error(`${option ?? '指定'} に値が無い（例: --port 7878）`, { cause: error });
    }
    throw error;
  }
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
