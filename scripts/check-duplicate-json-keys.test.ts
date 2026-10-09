import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { findDuplicateJsonKeys } from './check-duplicate-json-keys-core.mjs';

// git の自動の取り込みが実際に作った形（storage-fs の package.json）
const MERGED_TWICE = `{
  "name": "@drawroid/storage-fs",
  "dependencies": {
    "@drawroid/core": "workspace:*",
    "yaml": "catalog:"
  },
  "devDependencies": {
    "typescript": "catalog:"
  },
  "dependencies": {
    "@drawroid/core": "workspace:*",
    "zod": "catalog:"
  }
}
`;

describe('findDuplicateJsonKeys', () => {
  it('finds a key that a merge wrote twice, which JSON.parse would silently overwrite', () => {
    expect(JSON.parse(MERGED_TWICE).dependencies).not.toHaveProperty('yaml');
    expect(findDuplicateJsonKeys(MERGED_TWICE)).toEqual({
      verdict: 'duplicated',
      duplicates: ['/dependencies'],
      error: null,
    });
  });

  it('finds keys repeated deep inside nested objects and arrays', () => {
    const text = '{"a": [{"b": {"c": 1, "c": 2}}], "d": {"e": 1}}';

    expect(findDuplicateJsonKeys(text).duplicates).toEqual(['/a[0]/b/c']);
  });

  it('accepts the same key in different objects', () => {
    const text = '{"dependencies": {"zod": "1"}, "devDependencies": {"zod": "1"}}';

    expect(findDuplicateJsonKeys(text).verdict).toBe('clean');
  });

  it('reads keys with escaped quotes and strings that look like JSON', () => {
    const text = '{"a\\"b": "{\\"x\\": 1, \\"x\\": 2}", "c": [1, true, null, "]"]}';

    expect(findDuplicateJsonKeys(text).verdict).toBe('clean');
  });

  it('reports text that is not JSON as unreadable rather than clean', () => {
    expect(findDuplicateJsonKeys('{"a": 1,').verdict).toBe('unreadable');
  });
});

describe('check-duplicate-json-keys command', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  function run(content: string): number {
    dir = mkdtempSync(join(tmpdir(), 'dup-keys-'));
    const file = join(dir, 'package.json');
    writeFileSync(file, content);
    try {
      execFileSync('node', ['scripts/check-duplicate-json-keys.mjs', file], { stdio: 'pipe' });
      return 0;
    } catch (error) {
      return (error as { status: number }).status;
    }
  }

  it('fails on a package.json with a duplicated key', () => {
    expect(run(MERGED_TWICE)).toBe(1);
  });

  it('passes on a package.json without one', () => {
    expect(run('{"name": "x", "dependencies": {"zod": "1"}}')).toBe(0);
  });
});
