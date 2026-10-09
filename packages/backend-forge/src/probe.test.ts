import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ForgeClient } from './client.js';
import { probeForge } from './probe.js';
import { startMockForge, unusedUrl, type MockForge } from './test-support/mock-forge.js';

let forge: MockForge;

beforeEach(async () => {
  forge = await startMockForge();
});

afterEach(async () => {
  await forge.close();
});

describe('probeForge', () => {
  it('lists the features the adapter does not support yet, with a reason', async () => {
    const { unavailable } = await probeForge(
      new ForgeClient({ baseUrl: forge.url, timeoutMs: 5_000 }),
    );
    expect(unavailable.map((u) => u.feature).sort()).toEqual(['controlnet', 'img2img', 'inpaint']);
    for (const u of unavailable) expect(u.reason).not.toBe('');
  });

  it('fails as unreachable when Forge is down', async () => {
    const client = new ForgeClient({ baseUrl: await unusedUrl(), timeoutMs: 5_000 });
    await expect(probeForge(client)).rejects.toMatchObject({ kind: 'unreachable' });
  });
});
