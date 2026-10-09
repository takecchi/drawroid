import { describe, expect, it } from 'vitest';

import type { ReferenceRecord } from '../job/types.js';
import { DEFAULT_BUDGET, DEFAULT_MODEL_WINDOW } from '../loop/budget.js';
import { createCarry } from '../loop/carry.js';
import { buildRefGistInput, ImageNotAllowedError } from '../loop/inputs.js';
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

  it('refuses a reference that was already shown to the LLM', () => {
    expect(() => build({ ...preview, sentInCall: 'c1' })).toThrow(ImageNotAllowedError);
  });

  it('refuses a reference that was not shrunk', () => {
    expect(() => build({ ...preview, longEdge: 2000 })).toThrow(ImageNotAllowedError);
  });
});
