import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { usageText } from './args.js';

// build 済みの dist/index.js を起こす: 先に `pnpm build` が要る（CI は build を test より前に走らせる）
const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));

describe('drawroid --help (built entry)', () => {
  let scratch: string;
  let home: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'drawroid-help-'));
    // まだ無い場所を指す: 使い方を出すだけで作られないことを見るため
    home = join(scratch, 'home');
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  function run(...args: string[]) {
    return spawnSync(process.execPath, [entry, ...args], {
      env: { ...process.env, DRAWROID_HOME: home },
      encoding: 'utf8',
      timeout: 20_000,
    });
  }

  it.each(['--help', '-h'])(
    'prints the usage to stdout and exits 0 with %s, without creating the data directory',
    (flag) => {
      const result = run(flag);
      expect(result.stdout).toBe(usageText());
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(existsSync(home)).toBe(false);
    },
  );

  it('prints the usage even when another option is wrong', () => {
    const result = run('--help', '--port', 'abc');
    expect(result.stdout).toBe(usageText());
    expect(result.status).toBe(0);
  });

  it('does not print the usage for an unknown option: it fails and points to --help on stderr', () => {
    const result = run('--bogus');
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('知らない指定: --bogus');
    expect(result.stderr).toContain('使い方は drawroid --help');
    expect(result.status).toBe(1);
  });
});
