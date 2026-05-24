# 04 — Ingestion pipeline

Mirrors yt-chat's **Dexie-as-truth + content-hash dedup + batched/resumable indexer**, adding
**page-content fetch → markdown**. All of this runs in the **offscreen document** (`01`).

Key yt-chat references to port:
- `apps/web/src/db/pglite.ts`, `pglite-worker.ts`, `dexie.ts` (PGlite/Dexie setup + schema)
- `apps/web/src/services/cache.ts` (orchestration, TTL, sync/dedup)
- `apps/web/src/services/indexer.ts` (Dexie→PGlite batched indexing)

## Stage 0 — Data source: `chrome.bookmarks`

```ts
const tree = await chrome.bookmarks.getTree();
// flatten to URL nodes: { id, title, url, dateAdded, parentId } + computed folderPath
```
Build `folderPath` by walking parents (cache parent lookups). Ignore folder nodes (no `url`).

## Stage 1 — Upsert metadata into Dexie (source of truth)

Dexie schema (adapt `dexie.ts`), namespaced per Bodhi user id (or `default`):

```ts
bookmarks!: Table<CachedBookmark, string>; // key = bookmark id
meta!: Table<MetaRow, string>;             // cursors, TTLs

interface CachedBookmark {
  id: string;            // chrome.bookmarks node id
  title: string;
  url: string;
  folderPath: string;
  dateAdded: number;     // ms epoch
  contentHash: string;   // sha256(title + url + folderPath)  → metadata dedup
  content?: string;      // fetched markdown (recent ~200 only); undefined until fetched
  contentHashFetched?: string; // hash of the fetched content (to skip re-index)
  contentStatus: 'pending' | 'fetched' | 'skipped' | 'error';
  indexedAt: number;     // 0 = needs (re)index into PGlite, else epoch-ms
}
```

`syncBookmarks()` (port yt-chat `syncTable`): diff fresh tree vs Dexie; for each fresh node
compute `contentHash`; keep `indexedAt` if unchanged else reset to `0`; `bulkPut`; delete rows
that vanished (and delete their PGlite docs).

## Stage 2 — PGlite schema + metadata indexing

PGlite via `PGliteWorker` with `pg_textsearch` (port `pglite.ts`, `pglite-worker.ts`):

```sql
CREATE EXTENSION IF NOT EXISTS pg_textsearch;
CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,   -- bookmark id
  title       TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL DEFAULT '',
  folder      TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',  -- title + url + folder [+ markdown when fetched]
  date_added  BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_documents_bm25
  ON documents USING bm25 (content)
  WITH (text_config='english', k1=1.2, b=0.75);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
```

- Versioned schema (`SCHEMA_VERSION`): on mismatch, DROP + recreate, then rebuild from Dexie.
- On init failure, delete the `idb://` volume and rebuild from Dexie (yt-chat resilience).
- **Indexer** (port `indexer.ts`): select Dexie rows where `indexedAt = 0`, batch (`INDEX_BATCH
  = 200`), `upsertDocuments(batch)` (parameterized multi-row `INSERT … ON CONFLICT DO UPDATE`),
  mark `indexedAt = now`. After a pass that changed rows: REINDEX + CHECKPOINT (avoids
  "Invalid docid page magic"). Metadata-only `content` = `` `${title} ${url} ${folder}` ``.

This makes **all** bookmarks searchable immediately (Phase 2), before any content fetch.

## Stage 3 — Content fetch → markdown (recent ~200)

Add deps:
```bash
npm i @mozilla/readability turndown
# (readability needs a DOM Document; offscreen has one — use DOMParser)
```

Selection: `recent = bookmarks sorted by dateAdded desc, take N` (N=200 default; store N in
`meta` so it's tunable). Mark those `contentStatus='pending'`.

Pipeline (sequential, throttled — **one URL at a time**, tiny pool ≤ 2–3, polite delay):
```ts
for (const bm of pendingContent) {           // resumable: persist cursor in chrome.storage.local
  try {
    const res = await fetch(bm.url, { redirect: 'follow' });           // <all_urls> host perm
    if (!res.ok || !/text\/html/.test(res.headers.get('content-type') ?? '')) { skip(bm); continue; }
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const article = new Readability(doc).parse();                       // {title, content(html), …}
    const markdown = new TurndownService().turndown(article?.content ?? '');
    const md = (markdown || '').slice(0, MAX_CONTENT_CHARS);            // cap (e.g. 50k)
    await setContent(bm.id, md);   // Dexie: content, contentHashFetched, contentStatus='fetched', indexedAt=0
  } catch (e) { markError(bm, e); }
  emitProgress();
}
await runIndexPending();          // re-index changed docs; content now = title+url+folder + md
```
- Per-URL failures (CORS-less but 4xx/5xx/timeouts/non-HTML/paywall) → `contentStatus='error'|'skipped'`, never block the queue.
- Re-fetch policy: only when `contentHash` (metadata) changed or content TTL elapsed; skip if
  `contentHashFetched` already current.
- Optional: a `fetchTimeoutMs` via `AbortController`.

## Stage 4 — Triggers, scheduling, resumability

- **Kickoff**: after auth-ready (SW observes `BodhiExtClient` state), SW calls `ensureOffscreen()`
  + posts `ingest:start`. Offscreen runs Stage 1→2 (fast), then Stage 3 (gradual).
- **Resume**: persist a cursor + phase in `chrome.storage.local`; `chrome.alarms` (e.g. every
  1–2 min while work remains) re-pokes the offscreen doc after SW suspension.
- **Live updates**: `chrome.bookmarks.onCreated/onChanged/onRemoved` → Dexie upsert/delete +
  `indexedAt=0` (+ `contentStatus='pending'` if recent) → incremental re-index.
- **Progress**: emit `ingest:progress { phase: 'metadata'|'content', done, total, errors }` for the
  UI status indicator.

## Acceptance criteria
- After login with K seeded bookmarks, `db:count.documents === K` within seconds (metadata
  phase), before content fetch completes.
- Content phase fetches only the recent ~N; a 404/timeout on one URL does not stop the rest
  (its row ends `contentStatus='error'`).
- Adding a bookmark at runtime makes it searchable without reload (live update path).
- Reload/SW-kill mid-content resumes from the cursor (no duplicate fetches, no re-index of
  unchanged docs).
