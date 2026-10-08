import { describe, expect, it } from 'vitest';

import { parseCliArgs } from './args.js';
import { DEFAULT_PORT } from './listen.js';

describe('parseCliArgs', () => {
  it('uses the default port when none is given', () => {
    expect(parseCliArgs([])).toEqual({ port: DEFAULT_PORT, dataDir: undefined });
  });

  it('accepts --port', () => {
    expect(parseCliArgs(['--port', '9000'])).toMatchObject({ port: 9000 });
  });

  it('accepts --data-dir', () => {
    expect(parseCliArgs(['--data-dir', '/data'])).toMatchObject({ dataDir: '/data' });
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
