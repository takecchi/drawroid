import { describe, expect, it } from 'vitest';

import { parseCliArgs, usageText } from './args.js';
import { DEFAULT_PORT } from './listen.js';

describe('usageText', () => {
  it('lists the commands and options with their defaults', () => {
    expect(usageText()).toBe(`使い方: drawroid [doctor] [指定]

  drawroid         待ち受けを始める（画面は http://127.0.0.1:<ポート>/ で開く）
  drawroid doctor  設定ファイル・画像のバックエンド・LLM・web の配り先を確かめて終わる（何も書き換えない）

指定:
  --port <番号>        待ち受けるポート（既定 7878）
  --data-dir <場所>    データディレクトリ（既定は環境変数 DRAWROID_HOME、無ければ ~/.drawroid）
  --backend <種類>     画像のバックエンドの種類。forge か a1111（既定は config.json の backend.kind、無ければ forge）
  --backend-url <URL>  画像のバックエンドの URL。古い名前 --forge-url も受ける（既定は config.json の backend.url、無ければ http://127.0.0.1:7860）
  -h, --help           この使い方を出して終わる

LLM などの設定は、起動して画面の「設定」から入れるか、データディレクトリの config.json に書く。
`);
  });
});

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

  it('asks for the usage with --help or -h, before checking the other options', () => {
    expect(parseCliArgs(['--help'])).toMatchObject({ command: 'help' });
    expect(parseCliArgs(['-h'])).toMatchObject({ command: 'help' });
    expect(parseCliArgs(['--help', '--port', 'abc'])).toMatchObject({ command: 'help' });
    expect(parseCliArgs(['--port', 'abc', '-h'])).toMatchObject({ command: 'help' });
    expect(parseCliArgs(['--backend', 'comfyui', '--help'])).toMatchObject({ command: 'help' });
    expect(parseCliArgs(['doctor', '--help'])).toMatchObject({ command: 'help' });
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

  it('names an unknown option in Japanese with what it takes and where the usage is, instead of the raw parser message', () => {
    for (const [args, option] of [
      [['doctor', '--verbose'], '--verbose'],
      [['--version'], '--version'],
      [['-v'], '-v'],
    ] as const) {
      expect(() => parseCliArgs([...args])).toThrow(
        `知らない指定: ${option}（使えるのは doctor と --port・--data-dir・--backend・--backend-url（古い名前 --forge-url）。使い方は drawroid --help）`,
      );
      expect(() => parseCliArgs([...args])).not.toThrow(/Unknown option|place it at the end/);
    }
  });

  it('points to the usage when the command is not known', () => {
    expect(() => parseCliArgs(['serve'])).toThrow(
      '知らない指定: serve（使えるのは doctor だけ。使い方は drawroid --help）',
    );
    expect(() => parseCliArgs(['help'])).toThrow('使い方は drawroid --help');
  });

  it('says an option is missing its value in Japanese', () => {
    expect(() => parseCliArgs(['--port'])).toThrow('--port に値が無い（例: --port 7878）');
    expect(() => parseCliArgs(['--port'])).not.toThrow(/argument missing/);
  });

  it('shows, for an option missing its value, an example of that option', () => {
    for (const [option, example] of [
      ['--port', '--port 7878'],
      ['--data-dir', '--data-dir /tmp/drawroid-check'],
      ['--backend', '--backend a1111'],
      ['--backend-url', '--backend-url http://127.0.0.1:7860'],
      ['--forge-url', '--forge-url http://127.0.0.1:7860'],
    ] as const) {
      expect(() => parseCliArgs([option])).toThrow(`${option} に値が無い（例: ${example}）`);
    }
  });

  it('names the option that is missing its value, whichever option it is, also when another option follows', () => {
    expect(() => parseCliArgs(['--data-dir'])).toThrow('--data-dir に値が無い');
    expect(() => parseCliArgs(['doctor', '--backend-url'])).toThrow('--backend-url に値が無い');
    // 次の語が -- で始まっても、-- を挟んだ書き方の断りにはしない
    const run = () => parseCliArgs(['--data-dir', '--port', '7878']);
    expect(run).toThrow('--data-dir に値が無い');
    expect(run).not.toThrow(/-- を挟まずに/);
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
