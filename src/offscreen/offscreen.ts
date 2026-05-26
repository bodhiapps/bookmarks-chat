import { getDexie } from '@/db/dexie';
import { documentCount } from '@/db/pglite';
import { indexPending } from '@/services/indexer';
import { searchDocuments } from '@/services/search';
import { syncBookmarks } from '@/services/sync';
import type { BookmarkNode } from '@/lib/bookmarks';
import type { DbCountReply, IngestProgress, Message } from '@/lib/messages';

function emitProgress(p: IngestProgress): void {
  chrome.runtime.sendMessage({ type: 'ingest:progress', payload: p } satisfies Message).catch(() => {});
}

async function countReply(ns: string): Promise<DbCountReply> {
  const db = getDexie(ns);
  const documents = await documentCount(ns);
  const pendingContent = await db.bookmarks.where('contentStatus').equals('pending').count();
  return { documents, pendingContent };
}

async function runIngest(ns: string, nodes: BookmarkNode[]): Promise<void> {
  await syncBookmarks(ns, nodes);
  const total = nodes.length;
  emitProgress({ phase: 'metadata', done: 0, total, errors: 0 });
  const indexed = await indexPending(ns);
  emitProgress({ phase: 'metadata', done: indexed, total, errors: 0 });
}

chrome.runtime.onMessage.addListener((msg: Message) => {
  const ns = 'default';
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'db:count') {
    void countReply(ns).then((payload) => {
      chrome.runtime.sendMessage({ type: 'db:count:reply', requestId: msg.requestId, payload } satisfies Message).catch(() => {});
    });
    return;
  }
  if (msg.type === 'db:query') {
    void searchDocuments(ns, msg.payload).then((payload) => {
      chrome.runtime.sendMessage({ type: 'db:query:reply', requestId: msg.requestId, payload } satisfies Message).catch(() => {});
    });
    return;
  }
  if (msg.type === 'ingest:start') {
    chrome.runtime.sendMessage({ type: 'ingest:start:reply', requestId: msg.requestId, payload: { accepted: true } } satisfies Message).catch(() => {});
    void runIngest(ns, msg.payload.nodes);
    return;
  }
});

console.log('[offscreen] ready');
