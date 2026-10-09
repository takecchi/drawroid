import { BACKEND_ERROR_KINDS } from '@drawroid/core';
import { describe, expect, it } from 'vitest';

import { describeBackendError } from './backend-error';

describe('describeBackendError', () => {
  it.each(BACKEND_ERROR_KINDS)('explains what happened and what to do for %s', (kind) => {
    const description = describeBackendError(kind);
    expect(description?.summary).toBeTruthy();
    expect(description?.action).toBeTruthy();
  });

  it('tells a missing API from an unreachable Forge', () => {
    expect(describeBackendError('unreachable')?.summary).not.toBe(
      describeBackendError('not_found')?.summary,
    );
    expect(describeBackendError('not_found')?.action).toContain('--api');
  });

  it('has no description for errors that are not from the backend', () => {
    for (const kind of ['invalid_request', 'network', 'unknown', 'toString']) {
      expect(describeBackendError(kind), kind).toBeUndefined();
    }
  });
});
