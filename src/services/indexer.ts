import { type CachedBookmark, getDexie } from '@/db/dexie';
import { type DocumentRow, optimizeBm25Index, recoverPGlite, upsertDocuments } from '@/db/pglite';

export const INDEX_BATCH = 200;

export function bookmarkToDoc(row: CachedBookmark): DocumentRow {
  const content = row.content
    ? `${row.title} ${row.url} ${row.folderPath} ${row.content}`
    : `${row.title} ${row.url} ${row.folderPath}`;
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    folder: row.folderPath,
    content,
    date_added: row.dateAdded,
  };
}

async function runIndexPending(ns: string): Promise<number> {
  const db = getDexie(ns);
  const pending = await db.bookmarks.where('indexedAt').equals(0).toArray();
  if (pending.length === 0) return 0;
  let indexed = 0;
  for (let i = 0; i < pending.length; i += INDEX_BATCH) {
    const batch = pending.slice(i, i + INDEX_BATCH);
    await upsertDocuments(ns, batch.map(bookmarkToDoc));
    const now = Date.now();
    await db.bookmarks.bulkPut(batch.map(r => ({ ...r, indexedAt: now })));
    indexed += batch.length;
  }
  await optimizeBm25Index(ns);
  return indexed;
}

const chains = new Map<string, Promise<unknown>>();

export function indexPending(ns: string): Promise<number> {
  const prev = chains.get(ns) ?? Promise.resolve();
  const next = prev.then(
    () => runIndexPending(ns),
    () => runIndexPending(ns)
  );
  chains.set(
    ns,
    next.catch(() => {})
  );
  return next;
}

export async function rebuildIndex(ns: string): Promise<void> {
  await recoverPGlite(ns);
  const db = getDexie(ns);
  await db.bookmarks.toCollection().modify({ indexedAt: 0 });
  await indexPending(ns);
}
