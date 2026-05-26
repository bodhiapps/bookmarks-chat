import type { SearchHit, SearchParams } from '@/services/search';
import type { BookmarkNode } from '@/lib/bookmarks';

export const NS = 'default';

export type IngestPhase = 'metadata' | 'content';

export interface DbCountReply { documents: number; pendingContent: number }
export interface IngestProgress { phase: IngestPhase; done: number; total: number; errors: number }

export type Message =
  | { type: 'db:query'; requestId: string; payload: SearchParams }
  | { type: 'db:count'; requestId: string; payload: Record<string, never> }
  | { type: 'ingest:start'; requestId: string; payload: { reason: string; nodes: BookmarkNode[] } }
  | { type: 'ingest:progress'; payload: IngestProgress }
  | { type: 'db:query:reply'; requestId: string; payload: SearchHit[] }
  | { type: 'db:count:reply'; requestId: string; payload: DbCountReply }
  | { type: 'ingest:start:reply'; requestId: string; payload: { accepted: true } };

interface Pending { resolve: (v: unknown) => void; reject: (e: unknown) => void }
export const __registry = new Map<string, Pending>();

let _seq = 0;
export function nextRequestId(): string {
  _seq += 1;
  return `${Date.now().toString(36)}-${_seq}`;
}

export function resolvePending(requestId: string, value: unknown): void {
  const pending = __registry.get(requestId);
  if (!pending) return;
  __registry.delete(requestId);
  pending.resolve(value);
}

let _listenerInstalled = false;
function ensureReplyListener(): void {
  if (_listenerInstalled) return;
  _listenerInstalled = true;
  chrome.runtime.onMessage.addListener((msg: Message) => {
    if (msg && 'requestId' in msg && typeof msg.requestId === 'string' && msg.type.endsWith(':reply')) {
      resolvePending(msg.requestId, (msg as { payload: unknown }).payload);
    }
  });
}

export function queryOffscreen(type: 'db:count', payload: Record<string, never>): Promise<DbCountReply>;
export function queryOffscreen(type: 'db:query', payload: SearchParams): Promise<SearchHit[]>;
export function queryOffscreen(type: 'db:query' | 'db:count', payload: unknown): Promise<unknown> {
  ensureReplyListener();
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    __registry.set(requestId, { resolve, reject });
    chrome.runtime.sendMessage({ type, requestId, payload } as Message).catch(reject);
    setTimeout(() => {
      if (__registry.has(requestId)) { __registry.delete(requestId); reject(new Error(`${type} timed out`)); }
    }, 15000);
  });
}
