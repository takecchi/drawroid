import { describe, expect, it } from 'vitest';

import { parseCliArgs } from './args.js';
import { DEFAULT_PORT } from './listen.js';

describe('parseCliArgs', () => {
  it('uses the default port when none is given', () => {
    expect(parseCliArgs([])).toEqual({
      command: 'serve',
      port: DEFAULT_PORT,
      dataDir: undefined,
      backend: undefined,
      backendUrl: undefined,
    });
  });

  it('accepts doctor as the command, with the same options', () => {
    expect(parseCliArgs(['doctor', '--data-dir', '/data'])).toMatchObject({
      command: 'doctor',
      dataDir: '/data',
    });
  });

  it('refuses unknown commands and extra words', () => {
    expect(() => parseCliArgs(['serve'])).toThrow(/doctor/);
    expect(() => parseCliArgs(['doctor', 'now'])).toThrow(/doctor/);
  });

  it('accepts --port', () => {
    expect(parseCliArgs(['--port', '9000'])).toMatchObject({ port: 9000 });
  });

  it('accepts --data-dir', () => {
    expect(parseCliArgs(['--data-dir', '/data'])).toMatchObject({ dataDir: '/data' });
  });

  it('accepts --backend forge or a1111, and refuses other kinds', () => {
    expect(parseCliArgs(['--backend', 'a1111'])).toMatchObject({ backend: 'a1111' });
    expect(parseCliArgs(['--backend', 'forge'])).toMatchObject({ backend: 'forge' });
    expect(() => parseCliArgs(['--backend', 'comfyui'])).toThrow(/--backend/);
  });

  it('accepts --backend-url, and --forge-url as its old name', () => {
    expect(parseCliArgs(['--backend-url', 'http://gpu:7860'])).toMatchObject({
      backendUrl: 'http://gpu:7860',
    });
    expect(parseCliArgs(['--forge-url', 'http://gpu:7860'])).toMatchObject({
      backendUrl: 'http://gpu:7860',
    });
  });

  it('refuses --backend-url and --forge-url together', () => {
    expect(() =>
      parseCliArgs(['--backend-url', 'http://a:7860', '--forge-url', 'http://b:7860']),
    ).toThrow(/--backend-url と --forge-url/);
  });

  it('rejects a port outside 1-65535 or not an integer', () => {
    for (const bad of ['0', '65536', 'abc', '80.5']) {
      expect(() => parseCliArgs(['--port', bad])).toThrow(/--port/);
    }
  });

  it('rejects options it does not know, including a way to change the host', () => {
    expect(() => parseCliArgs(['--host', '0.0.0.0'])).toThrow();
  });

  it('names an unknown option in Japanese with what it takes, instead of the raw parser message', () => {
    for (const [args, option] of [
      [['--help'], '--help'],
      [['-h'], '-h'],
      [['doctor', '--verbose'], '--verbose'],
    ] as const) {
      expect(() => parseCliArgs([...args])).toThrow(
        `知らない指定: ${option}（使えるのは doctor と --port・--data-dir・--backend・--backend-url（古い名前 --forge-url））`,
      );
      expect(() => parseCliArgs([...args])).not.toThrow(/Unknown option|place it at the end/);
    }
  });

  it('says an option is missing its value in Japanese', () => {
    expect(() => parseCliArgs(['--port'])).toThrow('--port に値が無い（例: --port 7878）');
    expect(() => parseCliArgs(['--port'])).not.toThrow(/argument missing/);
  });

  it('tells to type the options without -- in between, instead of calling usable options unknown', () => {
    const run = () => parseCliArgs(['--', '--port', '7892', '--data-dir', '/data']);
    expect(run).toThrow(
      '-- を挟まずに打つ（例: pnpm drawroid --port 7892 --data-dir /data）。-- のあとの指定は受け取らない',
    );
    // 使える指定を「知らない」「使えるのは doctor だけ」と言わない
    expect(run).not.toThrow(/知らない指定|doctor だけ/);
  });

  it('keeps what came before -- in the example, and shows one when nothing follows it', () => {
    expect(() => parseCliArgs(['doctor', '--', '--backend-url', 'http://gpu:7860'])).toThrow(
      '（例: pnpm drawroid doctor --backend-url http://gpu:7860）',
    );
    expect(() => parseCliArgs(['--'])).toThrow('（例: pnpm drawroid --port 7878）');
  });
});
