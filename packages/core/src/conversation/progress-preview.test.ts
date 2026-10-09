import { describe, expect, it } from 'vitest';

import { ProgressPreviews } from './progress-preview.js';

const a = { data: new Uint8Array([1]), mediaType: 'image/png' as const };
const b = { data: new Uint8Array([2]), mediaType: 'image/jpeg' as const };

describe('ProgressPreviews', () => {
  it('returns what was set for that job', () => {
    const previews = new ProgressPreviews();
    previews.set('job-1', a);
    expect(previews.get('job-1')).toBe(a);
  });

  it('holds one image only: a newer set replaces the older one, even for another job', () => {
    const previews = new ProgressPreviews();
    previews.set('job-1', a);
    previews.set('job-1', b);
    expect(previews.get('job-1')).toBe(b);

    previews.set('job-2', a);
    expect(previews.get('job-1')).toBeUndefined();
    expect(previews.get('job-2')).toBe(a);
  });

  it('returns undefined for another job or when empty', () => {
    const previews = new ProgressPreviews();
    expect(previews.get('job-1')).toBeUndefined();
    previews.set('job-1', a);
    expect(previews.get('job-2')).toBeUndefined();
  });

  it('clears only when the job matches', () => {
    const previews = new ProgressPreviews();
    previews.set('job-1', a);
    previews.clear('job-2');
    expect(previews.get('job-1')).toBe(a);
    previews.clear('job-1');
    expect(previews.get('job-1')).toBeUndefined();
  });
});
