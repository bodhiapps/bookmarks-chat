import Dexie, { type Table } from 'dexie';

export type ContentStatus = 'pending' | 'fetched' | 'skipped' | 'error';

export interface CachedBookmark {
  id: string;
  title: string;
  url: string;
  folderPath: string;
  dateAdded: number;
  contentHash: string;
  content?: string;
  contentHashFetched?: string;
  contentStatus: ContentStatus;
  indexedAt: number;
}

export interface MetaRow {
  key: string;
  value: number;
}

export class BookmarksDexie extends Dexie {
  bookmarks!: Table<CachedBookmark, string>;
  meta!: Table<MetaRow, string>;

  constructor(ns: string) {
    super(`bookmarks-${ns}`);
    this.version(1).stores({
      bookmarks: 'id, indexedAt, contentStatus, dateAdded',
      meta: 'key',
    });
  }
}

let current: { ns: string; db: BookmarksDexie } | undefined;

export function getDexie(ns: string): BookmarksDexie {
  if (current && (current.ns !== ns || !current.db.isOpen())) {
    current.db.close();
    current = undefined;
  }
  if (!current) current = { ns, db: new BookmarksDexie(ns) };
  return current.db;
}

export function closeDexie(): void {
  if (current) {
    current.db.close();
    current = undefined;
  }
}

export async function contentHash(title: string, url: string, folderPath: string): Promise<string> {
  const data = new TextEncoder().encode(`${title} ${url} ${folderPath}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function getMeta(db: BookmarksDexie, key: string): Promise<number> {
  return (await db.meta.get(key))?.value ?? 0;
}
export async function setMeta(db: BookmarksDexie, key: string, value: number): Promise<void> {
  await db.meta.put({ key, value });
}
