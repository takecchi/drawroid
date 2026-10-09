// 偽の Forge。雛形は repo の packages/backend-forge の fixtures を実行時に読む（形が変われば fixtures と一緒に追従するため、ここへ写さない）。
// 生成に genMs かけ、その間 /sdapi/v1/progress が進む。
// holdGeneration() で、次の生成を releaseGeneration()（か /sdapi/v1/interrupt）まで止められる。待ちは合図で決まり、時間では決めない。
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { setTimeout } from 'node:timers';
import { URL } from 'node:url';
import { deflateSync } from 'node:zlib';

/** @type {Record<string, string>} */
const ROUTES = {
  'GET /sdapi/v1/sd-models': 'sd-models.json',
  'GET /sdapi/v1/sd-modules': 'sd-modules.json',
  'GET /sdapi/v1/loras': 'loras.json',
  'GET /sdapi/v1/samplers': 'samplers.json',
  'GET /sdapi/v1/schedulers': 'schedulers.json',
  'GET /sdapi/v1/cmd-flags': 'cmd-flags.json',
  'GET /sdapi/v1/upscalers': 'upscalers.json',
  'GET /sdapi/v1/latent-upscale-modes': 'latent-upscale-modes.json',
  'GET /sdapi/v1/scripts': 'scripts.json',
  'GET /sdapi/v1/script-info': 'script-info.json',
  'GET /controlnet/model_list': 'controlnet-model-list.json',
  'GET /controlnet/module_list': 'controlnet-module-list.json',
};

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** @param {Buffer} buffer */
function crc(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = (crcTable[(c ^ byte) & 255] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} type
 * @param {Buffer} data
 */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, checksum]);
}

/**
 * 画像を縮小して webp にできる、小さな本物の PNG。
 * @param {number} n 回ごとに色を変える
 * @param {number} [size]
 */
export function makePng(n, size = 64) {
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = y * stride + 1 + x * 3;
      raw[o] = (n * 80 + x * 3) & 255;
      raw[o + 1] = (y * 4 + n * 40) & 255;
      raw[o + 2] = (200 - n * 50) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * @param {{ fixturesDir: string, genMs: number, imageSize?: number }} options imageSize は生成する画像の一辺（省けば 64）
 * @returns {Promise<{ url: string, close: () => Promise<void>, stats: { txt2img: number, heldGenerations: number, interrupts: number }, holdGeneration: () => void, releaseGeneration: () => void }>}
 */
export async function startFakeForge({ fixturesDir, genMs, imageSize }) {
  /** @param {string} name */
  const fixture = (name) => JSON.parse(readFileSync(`${fixturesDir}/${name}`, 'utf8'));
  let genCount = 0;
  /** @type {number | null} */
  let genStart = null;
  // 次の生成を止めるか、いま止まっている生成を解く
  const stats = { txt2img: 0, heldGenerations: 0, interrupts: 0 };
  let holdNext = false;
  /** @type {(() => void) | null} */
  let releaseHeld = null;
  /**
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   * @param {unknown} body
   */
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const key = `${req.method} ${path}`;
      const route = ROUTES[key];
      if (route !== undefined) return send(res, 200, fixture(route));
      // 版を読む口（drawroid doctor が使う）。中身は大きいので、読む欄（Version）だけを返す。
      // 値の形（f<Forge の版>v<元の A1111 の版>-…）は Forge の git の tag からの推測で、実機では未確認
      if (key === 'GET /internal/sysinfo') {
        return send(res, 200, { Version: 'f2.0.1v1.10.1-previous-669-gdfdcbab6' });
      }
      if (key === 'POST /sdapi/v1/interrupt') {
        stats.interrupts++;
        releaseHeld?.();
        return send(res, 200, {});
      }
      if (key === 'GET /sdapi/v1/progress') {
        if (genStart === null) return send(res, 200, fixture('progress-idle.json'));
        const f = Math.min(0.99, (Date.now() - genStart) / genMs);
        return send(res, 200, {
          progress: f,
          eta_relative: ((1 - f) * genMs) / 1000,
          state: {
            job_count: 1,
            job_no: 0,
            sampling_step: Math.round(f * 20),
            sampling_steps: 20,
            skipped: false,
            interrupted: false,
            stopping_generation: false,
            job: 'Batch 1 out of 1',
            job_timestamp: '20250101120000',
          },
          current_image: null,
          textinfo: null,
        });
      }
      if (key === 'POST /sdapi/v1/txt2img') {
        const params = JSON.parse(body || '{}');
        const n = genCount++;
        stats.txt2img++;
        genStart = Date.now();
        if (holdNext) {
          holdNext = false;
          stats.heldGenerations++;
          await new Promise((resolve) => {
            releaseHeld = () => resolve(undefined);
            res.on('close', () => resolve(undefined));
          });
          releaseHeld = null;
        } else {
          await new Promise((resolve) => setTimeout(resolve, genMs));
        }
        genStart = null;
        if (res.destroyed) return;
        const batchSize = params.batch_size ?? 1;
        const seed = params.seed === undefined || params.seed === -1 ? 123456 : params.seed;
        const seeds = Array.from({ length: batchSize }, (_, i) => seed + i);
        return send(res, 200, {
          images: seeds.map(() => makePng(n, imageSize).toString('base64')),
          parameters: params,
          info: JSON.stringify({
            seed,
            all_seeds: seeds,
            infotexts: seeds.map((s) => `x\nSteps: 20, Seed: ${s}`),
            index_of_first_image: 0,
          }),
        });
      }
      send(res, 404, { detail: 'Not Found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('偽の Forge のポートを取れなかった');
  return {
    stats,
    holdGeneration: () => {
      holdNext = true;
    },
    releaseGeneration: () => releaseHeld?.(),
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
