import { describe, expect, it } from 'vitest';

import type { Candidate, CandidateKind } from '../backend.js';
import { mergePermissions } from '../permissions/permission.js';
import { basicPermissions, shownCandidatesFor } from './iteration-permissions.js';

const named = (prefix: string, count: number): Candidate[] =>
  Array.from({ length: count }, (_, n) => ({ name: `${prefix}-${String(n).padStart(3, '0')}` }));

const limits = { maxCount: 10, maxSize: 300 };

describe('shownCandidatesFor', () => {
  it.each<{ kind: CandidateKind; key: 'checkpoint' | 'controlnet' }>([
    { kind: 'checkpoint', key: 'checkpoint' },
    { kind: 'controlnetModel', key: 'controlnet' },
    { kind: 'controlnetModule', key: 'controlnet' },
  ])(
    'keeps the $kind list within the budget with hundreds of candidates, recording the ones left out',
    ({ kind, key }) => {
      const permissions = mergePermissions(basicPermissions({ width: 512, height: 512 }), {
        [key]: { mode: 'auto' },
      });

      const { shown, dropped } = shownCandidatesFor({
        permissions,
        lists: { [kind]: named(kind, 500) },
        notes: { notes: new Map() },
        requestGist: '',
        limits,
      });

      const list = shown[kind] ?? [];
      expect(list.length).toBeLessThanOrEqual(limits.maxCount);
      expect(list.reduce((sum, c) => sum + c.name.length, 0)).toBeLessThanOrEqual(limits.maxSize);
      expect(dropped.filter((d) => d.kind === kind)).toHaveLength(500 - list.length);
    },
  );
});
