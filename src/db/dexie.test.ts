import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { closeDexie, contentHash, getDexie, getMeta, setMeta } from './dexie';

const NS = 'test';
beforeEach(async () => {
  closeDexie();
  await getDexie(NS).delete();
});

describe('BookmarksDexie', () => {
  it('stores and reads back a bookmark', async () => {
    const db = getDexie(NS);
    await db.bookmarks.put({
      id: '1',
      title: 'T',
      url: 'https://x',
      folderPath: 'A/B',
      dateAdded: 5,
      contentHash: await contentHash('T', 'https://x', 'A/B'),
      contentStatus: 'pending',
      indexedAt: 0,
    });
    const row = await db.bookmarks.get('1');
    expect(row?.url).toBe('https://x');
    expect(await db.bookmarks.where('indexedAt').equals(0).count()).toBe(1);
  });

  it('contentHash is stable and field-sensitive', async () => {
    const a = await contentHash('T', 'u', 'f');
    const b = await contentHash('T', 'u', 'f');
    const c = await contentHash('T', 'u', 'f2');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('meta get/set round-trips', async () => {
    const db = getDexie(NS);
    expect(await getMeta(db, 'k')).toBe(0);
    await setMeta(db, 'k', 7);
    expect(await getMeta(db, 'k')).toBe(7);
  });
});
