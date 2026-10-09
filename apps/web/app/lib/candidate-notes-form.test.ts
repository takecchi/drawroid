import { describe, expect, it } from 'vitest';

import {
  buildNotes,
  matchesFilter,
  MAX_CANDIDATE_NOTE_CHARS,
  orphanNames,
} from './candidate-notes-form';

describe('buildNotes', () => {
  it('keeps the trimmed notes and leaves out the ones that were emptied', () => {
    expect(
      buildNotes({ 'detail.safetensors': '  細部を足す ', 'style.safetensors': '   ', vae: '' }),
    ).toEqual({ ok: true, value: { 'detail.safetensors': '細部を足す' } });
  });

  it('refuses a note that is too long and says which candidate it was for', () => {
    const result = buildNotes({ 'detail.safetensors': 'あ'.repeat(MAX_CANDIDATE_NOTE_CHARS + 1) });

    expect(result).toEqual({
      ok: false,
      reason: `detail.safetensors: 説明は ${MAX_CANDIDATE_NOTE_CHARS} 文字まで（いまは ${MAX_CANDIDATE_NOTE_CHARS + 1} 文字）`,
    });
  });
});

describe('orphanNames', () => {
  it('lists the names that have a note but are not among the candidates now', () => {
    expect(
      orphanNames({ gone: 'x', 'detail.safetensors': 'y', 'also-gone': 'z' }, [
        'detail.safetensors',
      ]),
    ).toEqual(['also-gone', 'gone']);
  });
});

describe('matchesFilter', () => {
  it('finds a candidate by any part of its name, ignoring case', () => {
    expect(matchesFilter('Detail_Tweaker.safetensors', 'tweak')).toBe(true);
    expect(matchesFilter('Detail_Tweaker.safetensors', '')).toBe(true);
    expect(matchesFilter('Detail_Tweaker.safetensors', 'style')).toBe(false);
  });
});
