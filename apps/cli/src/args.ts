import { parseArgs } from 'node:util';

import { DEFAULT_PORT } from './listen.js';

export interface CliOptions {
  port: number;
  dataDir: string | undefined;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: { port: { type: 'string' }, 'data-dir': { type: 'string' } },
    strict: true,
  });
  return { port: parsePort(values.port), dataDir: values['data-dir'] };
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--port は 1〜65535 の整数で指定する（受け取った値: ${raw}）`);
  }
  return port;
}
