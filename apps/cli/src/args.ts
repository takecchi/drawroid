import { parseArgs } from 'node:util';

import { backendKindSchema, type BackendKind } from '@drawroid/api';

import { DEFAULT_BACKEND_KIND, DEFAULT_BACKEND_URL } from './config.js';
import { DEFAULT_PORT } from './listen.js';

/** 何をするか。省けば待ち受けを始める。doctor は、実機で試す前に設定と繋がりを一度に確かめて終わる。help は使い方を出して終わる */
export type CliCommand = 'serve' | 'doctor' | 'help';

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
  help: { type: 'boolean', short: 'h' },
} as const;

const USABLE =
  '使えるのは doctor と --port・--data-dir・--backend・--backend-url（古い名前 --forge-url）。使い方は drawroid --help';

// 値の無い指定に、その指定の例を見せる。ここに無い指定のときは --port の例に戻す
const EXAMPLES: Record<string, string> = {
  '--port': `--port ${DEFAULT_PORT}`,
  '--data-dir': '--data-dir /tmp/drawroid-check',
  '--backend': '--backend a1111',
  '--backend-url': `--backend-url ${DEFAULT_BACKEND_URL}`,
  '--forge-url': `--forge-url ${DEFAULT_BACKEND_URL}`,
};

export function usageText(): string {
  return `使い方: drawroid [doctor] [指定]

  drawroid         待ち受けを始める（画面は http://127.0.0.1:<ポート>/ で開く）
  drawroid doctor  設定ファイル・画像のバックエンド・LLM・web の配り先を確かめて終わる（何も書き換えない）

指定:
  --port <番号>        待ち受けるポート（既定 ${DEFAULT_PORT}）
  --data-dir <場所>    データディレクトリ（既定は環境変数 DRAWROID_HOME、無ければ ~/.drawroid）
  --backend <種類>     画像のバックエンドの種類。forge か a1111（既定は config.json の backend.kind、無ければ ${DEFAULT_BACKEND_KIND}）
  --backend-url <URL>  画像のバックエンドの URL。古い名前 --forge-url も受ける（既定は config.json の backend.url、無ければ ${DEFAULT_BACKEND_URL}）
  -h, --help           この使い方を出して終わる

LLM などの設定は、起動して画面の「設定」から入れるか、データディレクトリの config.json に書く。
`;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const { values, positionals } = parseKnownArgs(argv);
  // ほかの指定の検証より先に返す: 値の間違った指定と一緒でも、使い方を見たい人には使い方を出す
  if (values.help === true) {
    return {
      command: 'help',
      port: DEFAULT_PORT,
      dataDir: undefined,
      backend: undefined,
      backendUrl: undefined,
    };
  }
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
      const example = option === undefined ? undefined : EXAMPLES[option];
      throw new Error(`${option ?? '指定'} に値が無い（例: ${example ?? '--port 7878'}）`, {
        cause: error,
      });
    }
    throw error;
  }
}

function parseCommand(positionals: string[]): CliCommand {
  const [first, ...rest] = positionals;
  if (first === undefined) return 'serve';
  if (first === 'doctor' && rest.length === 0) return 'doctor';
  throw new Error(
    `知らない指定: ${positionals.join(' ')}（使えるのは doctor だけ。使い方は drawroid --help）`,
  );
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
