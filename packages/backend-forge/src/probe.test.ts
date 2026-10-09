import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ForgeClient } from './client.js';
import { probeForge } from './probe.js';
import { json, startMockForge, unusedUrl, type MockForge } from './test-support/mock-forge.js';

let forge: MockForge;
let client: ForgeClient;

beforeEach(async () => {
  forge = await startMockForge();
  client = new ForgeClient({ baseUrl: forge.url, timeoutMs: 5_000 });
});

afterEach(async () => {
  await forge.close();
});

const controlnetInfo = (isImg2img: boolean, units: number) => ({
  name: 'controlnet',
  is_alwayson: true,
  is_img2img: isImg2img,
  args: Array.from({ length: units }, () => ({ label: null, value: null })),
});

describe('probeForge', () => {
  it('reports every feature usable and counts the ControlNet units when ControlNet is loaded', async () => {
    expect(await probeForge(client)).toEqual({ unavailable: [], limits: { controlnetUnits: 3 } });
  });

  it('reports ControlNet unavailable, with a reason, when Forge has not loaded it', async () => {
    forge.route('GET /sdapi/v1/scripts', json(200, { txt2img: ['lora'], img2img: ['lora'] }));

    const { unavailable, limits } = await probeForge(client);

    expect(unavailable.map((u) => u.feature)).toEqual(['controlnet']);
    expect(unavailable[0]?.reason).toContain('sd_forge_controlnet');
    expect(limits).toBeUndefined();
  });

  it('takes the smaller unit count when txt2img and img2img differ', async () => {
    forge.route(
      'GET /sdapi/v1/script-info',
      json(200, [controlnetInfo(false, 5), controlnetInfo(true, 4)]),
    );

    expect((await probeForge(client)).limits).toEqual({ controlnetUnits: 4 });
  });

  it("falls back to Forge's default of three units when script-info cannot be read", async () => {
    forge.route('GET /sdapi/v1/script-info', json(200, { unexpected: true }));

    expect((await probeForge(client)).limits).toEqual({ controlnetUnits: 3 });
  });

  it('fails as unreachable when Forge is down', async () => {
    const down = new ForgeClient({ baseUrl: await unusedUrl(), timeoutMs: 5_000 });
    await expect(probeForge(down)).rejects.toMatchObject({ kind: 'unreachable' });
  });
});
