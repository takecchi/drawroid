import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MemoryItem } from '@drawroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFsMemoryStore } from './store.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drawroid-memory-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fingers: MemoryItem = {
  id: 'fingers',
  body: '指の崩れは許容しない',
  tags: ['手', '指'],
  scope: 'always',
  sources: ['20261009-153012-k3f9'],
  createdAt: '2026-10-09T15:40:00+09:00',
  updatedAt: '2026-10-09T15:40:00+09:00',
};

const handWritten = (front: string, body: string) => `---\n${front}\n---\n${body}\n`;

describe('createFsMemoryStore', () => {
  it('reads back what it wrote', async () => {
    const store = createFsMemoryStore(dir);

    await store.put(fingers);

    expect(await store.get('fingers')).toEqual(fingers);
    expect(await store.list()).toEqual({ items: [fingers], invalid: [] });
  });

  it('writes one Markdown file per item with the preferences in the body, readable by a human', async () => {
    await createFsMemoryStore(dir).put(fingers);

    expect(await readdir(dir)).toEqual(['fingers.md']);
    expect(await readFile(join(dir, 'fingers.md'), 'utf8')).toBe(
      [
        '---',
        'tags: [ 手, 指 ]',
        'scope: always',
        'sources: [ 20261009-153012-k3f9 ]',
        'createdAt: 2026-10-09T15:40:00+09:00',
        'updatedAt: 2026-10-09T15:40:00+09:00',
        '---',
        '指の崩れは許容しない',
        '',
      ].join('\n'),
    );
  });

  it('reflects a hand edit of the file on the next read', async () => {
    const store = createFsMemoryStore(dir);
    await store.put(fingers);
    await store.list();

    const path = join(dir, 'fingers.md');
    const edited = (await readFile(path, 'utf8'))
      .replace('指の崩れは許容しない', '指の崩れは1本までなら許容する')
      .replace('scope: always', 'scope: tagged');
    await writeFile(path, edited);

    const item = await store.get('fingers');
    expect(item?.body).toBe('指の崩れは1本までなら許容する');
    expect(item?.scope).toBe('tagged');
    expect((await store.list()).items.map((i) => i.body)).toEqual([
      '指の崩れは1本までなら許容する',
    ]);
  });

  it('picks up a file a human created by hand and forgets one a human deleted', async () => {
    const store = createFsMemoryStore(dir);
    await store.put(fingers);
    await store.list();

    await writeFile(
      join(dir, 'saturation.md'),
      handWritten(
        'scope: always\ncreatedAt: 2026-10-09T16:00:00+09:00\nupdatedAt: 2026-10-09T16:00:00+09:00',
        '彩度は控えめ',
      ),
    );
    await unlink(join(dir, 'fingers.md'));

    const { items } = await store.list();
    expect(items).toEqual([
      {
        id: 'saturation',
        body: '彩度は控えめ',
        tags: [],
        scope: 'always',
        sources: [],
        createdAt: '2026-10-09T16:00:00+09:00',
        updatedAt: '2026-10-09T16:00:00+09:00',
      },
    ]);
    expect(await store.get('fingers')).toBeNull();
  });

  it('reads files saved by editors that use CRLF line endings and a BOM', async () => {
    const text =
      '\uFEFF---\r\nscope: always\r\ncreatedAt: 2026-10-09T16:00:00Z\r\nupdatedAt: 2026-10-09T16:00:00Z\r\n---\r\n彩度は控えめ\r\n';
    await writeFile(join(dir, 'saturation.md'), text);

    expect((await createFsMemoryStore(dir).get('saturation'))?.body).toBe('彩度は控えめ');
  });

  it('takes the id from the file name, not from the front matter', async () => {
    await writeFile(
      join(dir, 'by-name.md'),
      handWritten(
        'id: by-front-matter\nscope: always\ncreatedAt: 2026-10-09T16:00:00Z\nupdatedAt: 2026-10-09T16:00:00Z',
        '好み',
      ),
    );

    expect((await createFsMemoryStore(dir).list()).items.map((i) => i.id)).toEqual(['by-name']);
  });

  it('lists a broken file as invalid with the reason, and still lists the others', async () => {
    const store = createFsMemoryStore(dir);
    await store.put(fingers);
    await writeFile(join(dir, 'no-front-matter.md'), '彩度は控えめ\n');
    await writeFile(
      join(dir, 'bad-scope.md'),
      handWritten(
        'scope: sometimes\ncreatedAt: 2026-10-09T16:00:00Z\nupdatedAt: 2026-10-09T16:00:00Z',
        '好み',
      ),
    );
    await writeFile(join(dir, 'bad-yaml.md'), handWritten('tags: [unclosed', '好み'));

    const { items, invalid } = await store.list();

    expect(items).toEqual([fingers]);
    expect(invalid.map((i) => i.id)).toEqual(['bad-scope', 'bad-yaml', 'no-front-matter']);
    expect(invalid.find((i) => i.id === 'bad-scope')?.reason).toContain('scope');
    await expect(store.get('bad-scope')).rejects.toThrow('scope');
  });

  it('ignores temp files, hidden files and files that are not Markdown', async () => {
    const store = createFsMemoryStore(dir);
    await store.put(fingers);
    await writeFile(join(dir, '.tmp-abc123-other.md'), 'half written');
    await writeFile(join(dir, '.fingers.md.swp'), 'editor swap');
    await writeFile(join(dir, 'notes.txt'), 'not a memory');

    expect(await store.list()).toEqual({ items: [fingers], invalid: [] });
  });

  it('replaces an item in place and leaves no temp files behind', async () => {
    const store = createFsMemoryStore(dir);
    await store.put(fingers);

    await store.put({
      ...fingers,
      body: '指の崩れは絶対に許容しない',
      updatedAt: '2026-10-10T09:00:00+09:00',
    });

    expect(await readdir(dir)).toEqual(['fingers.md']);
    expect((await store.get('fingers'))?.body).toBe('指の崩れは絶対に許容しない');
  });

  it('removes an item and says whether there was one', async () => {
    const store = createFsMemoryStore(dir);
    await store.put(fingers);

    expect(await store.remove('fingers')).toBe(true);
    expect(await store.remove('fingers')).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses ids that would point outside the memory directory or at a temp file', async () => {
    const store = createFsMemoryStore(join(dir, 'memory'));

    for (const id of ['../config', 'a/b', 'a\\b', '.tmp-x', '']) {
      await expect(store.get(id)).rejects.toThrow('記憶の ID');
      await expect(store.remove(id)).rejects.toThrow('記憶の ID');
      await expect(store.put({ ...fingers, id })).rejects.toThrow();
    }
  });

  it('rejects an item that does not match the memory item schema instead of writing it', async () => {
    const store = createFsMemoryStore(dir);

    await expect(store.put({ ...fingers, body: '' })).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });

  it('lists nothing when the memory directory does not exist yet', async () => {
    expect(await createFsMemoryStore(join(dir, 'missing')).list()).toEqual({
      items: [],
      invalid: [],
    });
  });
});

describe('createFsMemoryStore with ids and timestamps', () => {
  it('reads a hand-written file whose name contains a dot, by list and by get', async () => {
    await writeFile(
      join(dir, 'prefer.v1.md'),
      handWritten(
        [
          'tags: [ アニメ ]',
          'scope: tagged',
          'createdAt: 2026-10-09T15:40:00+09:00',
          'updatedAt: 2026-10-09T15:40:00+09:00',
        ].join('\n'),
        '線は細く',
      ),
    );
    const store = createFsMemoryStore(dir);

    const { items, invalid } = await store.list();

    expect(invalid).toEqual([]);
    expect(items.map((i) => i.id)).toEqual(['prefer.v1']);
    expect(await store.get('prefer.v1')).toMatchObject({ id: 'prefer.v1', body: '線は細く' });
  });

  it('keeps createdAt and updatedAt apart when they differ', async () => {
    const store = createFsMemoryStore(dir);
    const edited: MemoryItem = { ...fingers, updatedAt: '2026-10-10T09:00:00+09:00' };

    await store.put(edited);

    expect(await store.get('fingers')).toEqual(edited);
    expect((await store.list()).items).toEqual([edited]);
  });
});
