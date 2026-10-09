import { describe, expect, it } from 'vitest';

import { readJudge, readThink } from './stage-output';

describe('readThink', () => {
  it('reads params and rationale and tolerates extra fields', () => {
    const value = { params: { prompt: 'a cat', steps: 20, extra: 1 }, rationale: 'r', more: true };
    expect(readThink(value)).toEqual({ params: { prompt: 'a cat', steps: 20 }, rationale: 'r' });
  });

  it('reads the cfg scale the thinking role decided', () => {
    expect(readThink({ params: { cfgScale: 6.5 }, rationale: 'r' })).toEqual({
      params: { cfgScale: 6.5 },
      rationale: 'r',
    });
  });

  it('reads the cfg of a record written before the field was renamed as the cfg scale', () => {
    expect(readThink({ params: { cfg: 7 }, rationale: 'r' })).toEqual({
      params: { cfgScale: 7 },
      rationale: 'r',
    });
  });

  it('returns undefined when a required field is missing', () => {
    expect(readThink({ params: { prompt: 'a cat' } })).toBeUndefined();
    expect(readThink({ params: { steps: '20' }, rationale: 'r' })).toBeUndefined();
  });

  it('returns undefined for a completely different shape', () => {
    for (const value of [null, 'text', 3, [], { foo: 'bar' }]) {
      expect(readThink(value)).toBeUndefined();
    }
  });
});

describe('readJudge', () => {
  it('reads scores, issues, nextChange and canStop and tolerates extra fields', () => {
    const value = {
      images: [{ score: 0.8, issues: ['手が崩れている'], note: 'x' }],
      nextChange: 'もっと明るく',
      canStop: false,
      extra: 1,
    };
    expect(readJudge(value)).toEqual({
      images: [{ score: 0.8, issues: ['手が崩れている'] }],
      nextChange: 'もっと明るく',
      canStop: false,
    });
  });

  it('returns undefined when a required field is missing', () => {
    expect(readJudge({ images: [{ score: 0.5, issues: [] }], canStop: true })).toBeUndefined();
    expect(readJudge({ images: [{ issues: [] }], nextChange: '', canStop: true })).toBeUndefined();
  });

  it('returns undefined for a completely different shape', () => {
    for (const value of [null, 'text', 3, [], { foo: 'bar' }]) {
      expect(readJudge(value)).toBeUndefined();
    }
  });
});
