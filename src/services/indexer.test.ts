import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDexie, getDexie } from '@/db/dexie';
import { documentCount, recoverPGlite } from '@/db/pglite';
import { bookmarkToDoc, indexPending } from './indexer';

const NS = 'test';
beforeEach(async () => { closeDexie(); await getDexie(NS).delete(); });
afterEach(async () => { await recoverPGlite(NS); });

describe('indexer', () => {
  it('bookmarkToDoc builds content = title + url + folder', () => {
    const doc = bookmarkToDoc({
      id: '1', title: 'T', url: 'U', folderPath: 'F', dateAdded: 9,
      contentHash: 'h', contentStatus: 'pending', indexedAt: 0,
    });
    expect(doc).toEqual({ id: '1', title: 'T', url: 'U', folder: 'F', content: 'T U F', date_added: 9 });
  });

  it('indexes only pending rows then marks them indexed', async () => {
    const db = getDexie(NS);
    await db.bookmarks.bulkPut([
      { id: '1', title: 'A', url: 'u1', folderPath: '', dateAdded: 1, contentHash: 'h', contentStatus: 'pending', indexedAt: 0 },
      { id: '2', title: 'B', url: 'u2', folderPath: '', dateAdded: 2, contentHash: 'h', contentStatus: 'pending', indexedAt: 0 },
    ]);
    const n = await indexPending(NS);
    expect(n).toBe(2);
    expect(await documentCount(NS)).toBe(2);
    expect(await db.bookmarks.where('indexedAt').equals(0).count()).toBe(0);
    expect(await indexPending(NS)).toBe(0); // nothing pending second time
  });
});
