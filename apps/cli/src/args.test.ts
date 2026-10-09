import { describe, expect, it } from 'vitest';

import { parseCliArgs } from './args.js';
import { DEFAULT_PORT } from './listen.js';

describe('parseCliArgs', () => {
  it('uses the default port when none is given', () => {
    expect(parseCliArgs([])).toEqual({
      port: DEFAULT_PORT,
      dataDir: undefined,
      backend: undefined,
      backendUrl: undefined,
    });
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
});
