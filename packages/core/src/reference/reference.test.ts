import { describe, expect, it } from 'vitest';

import { DEFAULT_BUDGETS } from '../budget/settings.js';
import { MAX_REFERENCES_PER_REQUEST, type ReferenceRecord } from '../job/types.js';
import { DEFAULT_BUDGET, DEFAULT_MODEL_WINDOW } from '../loop/budget.js';
import { createCarry } from '../loop/carry.js';
import { buildRefGistInput, buildThinkInput, ImageNotAllowedError } from '../loop/inputs.js';
import { carriedReferences, DEFAULT_REFERENCE_LIMITS } from './reference.js';

const limits = { maxCount: 2, gistChars: 5, noteChars: 10 };

function received(refId: string, gist?: string): ReferenceRecord {
  return {
    refId,
    receivedAt: '2026-10-09T00:00:00Z',
    mediaType: 'image/png',
    ...(gist === undefined ? {} : { gist }),
  };
}

describe('carriedReferences', () => {
  it('carries only the newest gists up to the count limit, clipped, in the order received', () => {
    expect(
      carriedReferences(
        [
          received('a', '古い要点'),
          received('b'),
          received('c', '青い背景で'),
          received('d', '逆光の海辺の少女'),
        ],
        limits,
      ),
    ).toEqual([
      { refId: 'c', gist: '青い背景で' },
      { refId: 'd', gist: '逆光の海辺' },
    ]);
  });

  // 既定では、1回の要求で添えてよい枚数を全部持ち回す: 少ないと、添えてよいと言った画像のうち最初のものが、考える役に一度も見えない
  const attached = (count: number) =>
    Array.from({ length: count }, (_, i) => received(`r${i + 1}`, `要点${i + 1}`));

  it('carries, by default, every image a single request may attach', () => {
    const carried = carriedReferences(
      attached(MAX_REFERENCES_PER_REQUEST),
      DEFAULT_BUDGETS.references,
    );

    expect(carried.map((reference) => reference.refId)).toEqual(
      attached(MAX_REFERENCES_PER_REQUEST).map((reference) => reference.refId),
    );
  });

  it('carries, by default, no more than a single request may attach', () => {
    const carried = carriedReferences(
      attached(MAX_REFERENCES_PER_REQUEST + 1),
      DEFAULT_BUDGETS.references,
    );

    expect(carried).toHaveLength(MAX_REFERENCES_PER_REQUEST);
    expect(carried[0]?.refId).toBe('r2');
  });
});

describe('buildRefGistInput', () => {
  const carry = createCarry('海辺の少女', DEFAULT_BUDGET).carry;
  const preview = {
    key: 'jobs/j1/refs/r1',
    data: new Uint8Array(16),
    mediaType: 'image/webp',
    longEdge: 512,
  };
  const build = (image: typeof preview & { sentInCall?: string }) =>
    buildRefGistInput({
      carry,
      image,
      budget: DEFAULT_BUDGET,
      limits: DEFAULT_REFERENCE_LIMITS,
      window: DEFAULT_MODEL_WINDOW,
    });

  it('carries the shrunk reference as the only image', () => {
    const parts = build(preview).user.filter((part) => part.type === 'image');
    expect(parts.map((part) => part.type === 'image' && part.key)).toEqual(['jobs/j1/refs/r1']);
  });

  const textOf = (messages: ReturnType<typeof buildRefGistInput>) =>
    messages.user.map((part) => (part.type === 'text' ? part.text : '')).join('\n');

  it('clips the note the human added at the note limit', () => {
    const note = '用途'.repeat(200);
    const text = textOf(
      buildRefGistInput({
        carry,
        image: preview,
        note,
        budget: DEFAULT_BUDGET,
        limits: { ...DEFAULT_REFERENCE_LIMITS, noteChars: 10 },
        window: DEFAULT_MODEL_WINDOW,
      }),
    );
    expect(text).toContain('人間が添えた用途: ');
    expect(text).not.toContain(note);
    expect(text).not.toContain('用途'.repeat(11));
  });

  it('refuses a reference that was already shown to the LLM', () => {
    expect(() => build({ ...preview, sentInCall: 'c1' })).toThrow(ImageNotAllowedError);
  });

  it('refuses a reference that was not shrunk', () => {
    expect(() => build({ ...preview, longEdge: 2000 })).toThrow(ImageNotAllowedError);
  });
});

describe('reference gists in the thinking input (M3:102)', () => {
  const base = createCarry('海辺の少女', DEFAULT_BUDGET).carry;
  const carry = {
    ...base,
    references: [
      { refId: '000001', gist: '白いワンピースの立ち姿' },
      { refId: '000002', gist: '逆光の海辺' },
      { refId: '000003', gist: '青い背景' },
    ],
  };
  const build = (withImageSourceKeys?: boolean) =>
    buildThinkInput({
      carry,
      progress: { iteration: 1 },
      allowed: ['prompt'],
      budget: DEFAULT_BUDGET,
      window: DEFAULT_MODEL_WINDOW,
      ...(withImageSourceKeys === undefined ? {} : { withImageSourceKeys }),
    })
      .user.map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');

  it('carries every gist, not only the first', () => {
    const text = build();
    for (const reference of carry.references) expect(text).toContain(reference.gist);
  });

  it('writes the source image key next to a gist only when img2img is left to the AI', () => {
    expect(build(true)).toContain('ref:000002: 逆光の海辺');
    expect(build(false)).not.toContain('元画像のキー');
    expect(build(false)).not.toContain('ref:000002');
  });
});
