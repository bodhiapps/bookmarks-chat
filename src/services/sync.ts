import { type BookmarkNode } from '@/lib/bookmarks';
import { type CachedBookmark, contentHash, getDexie } from '@/db/dexie';
import { deleteDocuments } from '@/db/pglite';

interface FreshHashed {
  id: string;
  hash: string;
}
interface ExistingHashed {
  id: string;
  contentHash: string;
  indexedAt: number;
}

export function diffRows(
  fresh: FreshHashed[],
  existing: ExistingHashed[]
): { toPutIndexedAt: Map<string, number>; toDelete: string[] } {
  const existingById = new Map(existing.map(r => [r.id, r]));
  const freshIds = new Set(fresh.map(f => f.id));
  const toPutIndexedAt = new Map<string, number>();
  for (const f of fresh) {
    const prev = existingById.get(f.id);
    toPutIndexedAt.set(f.id, prev && prev.contentHash === f.hash ? prev.indexedAt : 0);
  }
  const toDelete = existing.filter(r => !freshIds.has(r.id)).map(r => r.id);
  return { toPutIndexedAt, toDelete };
}

export async function syncBookmarks(ns: string, nodes: BookmarkNode[]): Promise<void> {
  const db = getDexie(ns);
  const existing = await db.bookmarks.toArray();
  const hashed = await Promise.all(
    nodes.map(async n => ({ node: n, hash: await contentHash(n.title, n.url, n.folderPath) }))
  );
  const { toPutIndexedAt, toDelete } = diffRows(
    hashed.map(h => ({ id: h.node.id, hash: h.hash })),
    existing.map(e => ({ id: e.id, contentHash: e.contentHash, indexedAt: e.indexedAt }))
  );
  const existingById = new Map(existing.map(e => [e.id, e]));
  const toPut: CachedBookmark[] = hashed.map(({ node, hash }) => {
    const prev = existingById.get(node.id);
    return {
      id: node.id,
      title: node.title,
      url: node.url,
      folderPath: node.folderPath,
      dateAdded: node.dateAdded,
      contentHash: hash,
      content: prev?.content,
      contentHashFetched: prev?.contentHashFetched,
      contentStatus: prev?.contentStatus ?? 'pending',
      indexedAt: toPutIndexedAt.get(node.id) ?? 0,
    };
  });
  await db.bookmarks.bulkPut(toPut);
  if (toDelete.length > 0) {
    await db.bookmarks.bulkDelete(toDelete);
    await deleteDocuments(ns, toDelete);
  }
}
