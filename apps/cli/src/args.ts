import { parseArgs } from 'node:util';

import { DEFAULT_PORT } from './listen.js';

export interface CliOptions {
  port: number;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: { port: { type: 'string' } },
    strict: true,
  });
  if (values.port === undefined) return { port: DEFAULT_PORT };
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--port は 1〜65535 の整数で指定する（受け取った値: ${values.port}）`);
  }
  return { port };
}
