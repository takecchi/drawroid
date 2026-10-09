import { describe, expect, it, vi } from 'vitest';

import { createPermissionReader } from './permission-reader.js';

describe('createPermissionReader', () => {
  it('gives the rows it can read and leaves the broken ones to the base', async () => {
    const read = createPermissionReader(
      async () => ({
        steps: { mode: 'fixed', value: 28 },
        cfgScale: { mode: 'fixed', value: 'x' },
      }),
      () => undefined,
    );

    expect(await read()).toEqual({ steps: { mode: 'fixed', value: 28 } });
  });

  it('logs the broken rows once, and again only when they change', async () => {
    let stored: unknown = { cfgScale: { mode: 'fixed', value: 'x' } };
    const log = vi.fn();
    const read = createPermissionReader(async () => stored, log);

    await read();
    await read();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('cfgScale');
    expect(log.mock.calls[0]?.[0]).toContain('既定に戻る');

    stored = { steps: { mode: 'off' } };
    await read();
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1]?.[0]).toContain('steps');

    stored = {};
    await read();
    await read();
    expect(log).toHaveBeenCalledTimes(3);
    expect(log.mock.calls[2]?.[0]).toContain('読めない許可は無くなった');
  });
});
