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

  it.each([
    'unreachable',
    'not_found',
    'unauthorized',
    'timeout',
    'bad_response',
    'failed',
  ] as const)('names A1111 and not Forge for %s when A1111 is chosen', (kind) => {
    const { summary, action } = describeBackendError(kind, 'a1111')!;
    const text = `${summary}${action}`;
    expect(text).toContain('A1111');
    expect(text).not.toContain('Forge');
  });

  it.each([
    'unreachable',
    'not_found',
    'unauthorized',
    'timeout',
    'bad_response',
    'failed',
  ] as const)('names Forge and not A1111 for %s when Forge is chosen', (kind) => {
    const { summary, action } = describeBackendError(kind, 'forge')!;
    const text = `${summary}${action}`;
    expect(text).toContain('Forge');
    expect(text).not.toContain('A1111');
  });

  it.each([
    'unreachable',
    'not_found',
    'unauthorized',
    'timeout',
    'bad_response',
    'failed',
  ] as const)('names both backends neutrally for %s when the chosen one is unknown', (kind) => {
    const { summary, action } = describeBackendError(kind)!;
    expect(`${summary}${action}`).toContain('バックエンド（Forge / A1111）');
  });

  it('has no description for errors that are not from the backend', () => {
    for (const kind of ['invalid_request', 'network', 'unknown', 'toString']) {
      expect(describeBackendError(kind), kind).toBeUndefined();
    }
  });
});
