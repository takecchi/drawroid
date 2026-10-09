import { describe, expect, it } from 'vitest';

import { describeExcludedReason, describeWanted } from './excluded-reason';

describe('describeExcludedReason', () => {
  it('says what the backend could not do, with its own detail', () => {
    expect(describeExcludedReason({ kind: 'backend', detail: 'ControlNet の拡張が無い' })).toBe(
      'バックエンドで使えない: ControlNet の拡張が無い',
    );
  });

  it.each([
    [{ kind: 'no-mask' }, 'マスクが無い'],
    [{ kind: 'no-candidates-shown' }, '候補を予算の内で1つも見せられなかった'],
  ] as const)('puts %j into words', (reason, words) => {
    expect(describeExcludedReason(reason)).toBe(words);
  });
});

describe('describeWanted', () => {
  it('names what the human decided', () => {
    expect(describeWanted('auto')).toBe('AI に任せる');
    expect(describeWanted('fixed')).toBe('固定');
  });
});
