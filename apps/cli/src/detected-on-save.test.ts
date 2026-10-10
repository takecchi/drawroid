import { describe, expect, it } from 'vitest';

import { createDetectedOnSave, type Detection } from './detected-on-save.js';

const detection = (label: string) => ({ config: { label }, detected: [] }) as unknown as Detection;

describe('createDetectedOnSave', () => {
  it('gives back what it remembered for the same object', () => {
    const memo = createDetectedOnSave();
    const input = {};
    const read = detection('a');
    memo.remember(input, read);

    expect(memo.recall(input)).toBe(read);
  });

  it('forgets once it was asked for', () => {
    const memo = createDetectedOnSave();
    const input = {};
    memo.remember(input, detection('a'));
    memo.recall(input);

    expect(memo.recall(input)).toBeUndefined();
  });

  it('does not give it to another object, even when the content is the same', () => {
    const memo = createDetectedOnSave();
    memo.remember({ same: 1 }, detection('a'));

    expect(memo.recall({ same: 1 })).toBeUndefined();
  });

  it('does not give back a read for the object it was not remembered for, even after being asked by another', () => {
    const memo = createDetectedOnSave();
    const input = {};
    memo.remember(input, detection('a'));
    memo.recall({});

    expect(memo.recall(input)).toBeUndefined();
  });

  it('keeps only the last one it remembered', () => {
    const memo = createDetectedOnSave();
    const first = {};
    const second = {};
    memo.remember(first, detection('a'));
    memo.remember(second, detection('b'));

    expect(memo.recall(first)).toBeUndefined();
  });

  it('gives back nothing before anything is remembered', () => {
    expect(createDetectedOnSave().recall({})).toBeUndefined();
  });
});
