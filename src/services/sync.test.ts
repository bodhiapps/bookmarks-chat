import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { closeDexie, getDexie } from '@/db/dexie';
import { diffRows, syncBookmarks } from './sync';

const NS = 'test';
beforeEach(async () => {
  closeDexie();
  await getDexie(NS).delete();
});

describe('diffRows', () => {
  it('keeps indexedAt when hash unchanged, resets when changed, deletes vanished', () => {
    const fresh = [
      { id: 'a', hash: 'h1' },
      { id: 'b', hash: 'h2new' },
    ];
    const existing = [
      { id: 'a', contentHash: 'h1', indexedAt: 111 },
      { id: 'b', contentHash: 'h2old', indexedAt: 222 },
      { id: 'c', contentHash: 'h3', indexedAt: 333 },
    ];
    const { toPutIndexedAt, toDelete } = diffRows(fresh, existing);
    expect(toPutIndexedAt.get('a')).toBe(111);
    expect(toPutIndexedAt.get('b')).toBe(0);
    expect(toDelete).toEqual(['c']);
  });
});

describe('syncBookmarks', () => {
  it('upserts fresh nodes into Dexie with pending status and indexedAt=0', async () => {
    await syncBookmarks(NS, [
      { id: '1', title: 'T', url: 'https://x', folderPath: 'A', dateAdded: 1 },
    ]);
    const db = getDexie(NS);
    const row = await db.bookmarks.get('1');
    expect(row?.indexedAt).toBe(0);
    expect(row?.contentStatus).toBe('pending');
  });
});
