import { A1111Backend } from '@drawroid/backend-a1111';
import { ForgeBackend } from '@drawroid/backend-forge';
import { describe, expect, it } from 'vitest';

import { backendFactory } from './backend-factory.js';

describe('backendFactory', () => {
  it('creates the adapter for the kind chosen in the settings', () => {
    const options = { baseUrl: 'http://127.0.0.1:7860' };
    expect(backendFactory('forge')(options)).toBeInstanceOf(ForgeBackend);
    expect(backendFactory('a1111')(options)).toBeInstanceOf(A1111Backend);
  });
});
