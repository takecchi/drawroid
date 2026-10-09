import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCandidateNotes } from './candidate-notes.js';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drawroid-candidate-notes-'));
  path = join(dir, 'candidate-notes.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readCandidateNotes', () => {
  it('reads the notes a human wrote, keyed by candidate name', async () => {
    await writeFile(
      path,
      JSON.stringify({ watercolor_v2: '水彩の滲み', animeMix: 'アニメ調向け' }),
    );

    const { notes, problem } = await readCandidateNotes(path);

    expect([...notes]).toEqual([
      ['watercolor_v2', '水彩の滲み'],
      ['animeMix', 'アニメ調向け'],
    ]);
    expect(problem).toBeUndefined();
  });

  it('has no notes and nothing to report when the file does not exist', async () => {
    expect(await readCandidateNotes(path)).toEqual({ notes: new Map() });
  });

  it('goes on without notes, saying why, when the file is not JSON', async () => {
    await writeFile(path, '{ "watercolor_v2": ');

    const { notes, problem } = await readCandidateNotes(path);

    expect(notes.size).toBe(0);
    expect(problem).toContain('candidate-notes.json');
  });

  it('goes on without notes, saying why, when the file is not a map of names to notes', async () => {
    await writeFile(path, JSON.stringify({ watercolor_v2: ['水彩'] }));

    const { notes, problem } = await readCandidateNotes(path);

    expect(notes.size).toBe(0);
    expect(problem).toContain('candidate-notes.json');
  });

  it('reads the file again on every call, so a human edit takes effect without a restart', async () => {
    await writeFile(path, JSON.stringify({ a: '一' }));
    await readCandidateNotes(path);
    await writeFile(path, JSON.stringify({ a: '二' }));

    expect((await readCandidateNotes(path)).notes.get('a')).toBe('二');
  });
});
