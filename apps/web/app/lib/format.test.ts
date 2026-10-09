import { describe, expect, it } from 'vitest';

import { formatDuration, formatScore } from './format';

describe('formatScore', () => {
  it('shows two decimal places without floating point noise', () => {
    expect(formatScore(0.44999999999999996)).toBe('0.45');
    expect(formatScore(1)).toBe('1.00');
  });
});

describe('formatDuration', () => {
  it('shows whole milliseconds below one second', () => {
    expect(formatDuration(21.788400999999794)).toBe('22 ms');
    expect(formatDuration(999.4)).toBe('999 ms');
  });

  it('shows seconds with one decimal place from one second on', () => {
    expect(formatDuration(1000)).toBe('1.0 秒');
    expect(formatDuration(67047.51)).toBe('67.0 秒');
  });
});
