# Phase 2 — Index core (offscreen PGlite/Dexie + metadata ingestion + `search_bookmarks`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make **all** browser bookmarks metadata-searchable from the chat: the service worker enumerates `chrome.bookmarks`, an offscreen document indexes them into PGlite (BM25 via `pg_textsearch`) with Dexie as the durable source of truth, and a local `search_bookmarks` agent tool returns a ranked GitHub-flavored-Markdown table — proven by an extended real-OAuth e2e (`search.spec.ts`) that is **green in GitHub Actions**.

**Architecture:** Three contexts (PRD `01`). The **UI tab** hosts the `search_bookmarks` AgentTool, which never touches PGlite directly — it sends `db:query`/`db:count` messages. The **service worker** (`background.ts`) owns `chrome.bookmarks` (enumerate `getTree()`, live `on*` events), calls `ensureOffscreen()`, and forwards bookmark nodes + ingest triggers. The **offscreen document** is the sole owner of PGlite (worker + wasm) and Dexie; it runs Dexie sync → batched PGlite indexing and answers `db:query`/`db:count`. Dexie = durable truth; PGlite = rebuildable BM25 index. Namespace is a single fixed `'default'` (PRD `01` permits this; multi-account by Bodhi `sub` is deferred).

**Tech Stack:** `@electric-sql/pglite@0.4.5` (PGliteWorker + `pg_textsearch` + `live`), `dexie@^4`, `@crxjs/vite-plugin`, `@mariozechner/pi-ai` (`Type`/`StringEnum`, already a dep), `react-markdown` + `remark-gfm`, Playwright (real-OAuth extension harness from Phase 1), Vitest.

**Scope:** ONLY Phase 2 of `docs/prd/` — **metadata** (title/url/folder) for **all** bookmarks. **Out of scope (Phase 3):** page-content fetch → readability → markdown, the `<all_urls>` host permission, content-search e2e. Build `content` as `title + url + folder` only; the `content` column and pipeline are structured so Phase 3 appends fetched markdown without schema change.

**Reference (read before starting):** `docs/prd/01-architecture.md`, `docs/prd/04-ingestion-pipeline.md` (Stages 0–2 & 4), `docs/prd/05-search-tool-and-agent.md`, `docs/prd/06-e2e-testing.md`. Port source lives at `/Users/amir36/Documents/workspace/src/github.com/bodhiapps/yt-chat/apps/web/src/` (referred to below as `YT/`). A local PGlite-in-browser reference: `/Users/amir36/Documents/workspace/src/github.com/bodhiapps/pglite-demo`.

---

## File structure (created/modified in Phase 2)

Created:
- `src/db/pglite.ts` — PGlite owner: schema, `ensureDb`, `query`, `upsertDocuments`, `deleteDocuments`, `documentCount`, `optimizeBm25Index`, `recoverPGlite`. (Port of `YT/db/pglite.ts`, bookmark columns, single `documents` table, no transcript table.)
- `src/db/pglite-worker.ts` — PGlite Web Worker entry (near-verbatim port).
- `src/db/dexie.ts` — `BookmarksDexie`, `CachedBookmark`, `getDexie`, `contentHash`, meta helpers.
- `src/services/sync.ts` — `diffRows`, `syncBookmarks` (Dexie diff/dedup; deletes cascade to PGlite).
- `src/services/indexer.ts` — `INDEX_BATCH`, `bookmarkToDoc`, `indexPending`, `rebuildIndex`.
- `src/services/search.ts` — `SearchParams`, `SearchHit`, `buildSearchQuery`, `searchDocuments`.
- `src/lib/messages.ts` — typed message contract + `requestId` Promise registry + `queryOffscreen()` helper + context guards.
- `src/lib/bookmarks.ts` — `BookmarkNode`, `flattenBookmarks(tree)` (folderPath compute). SW-side, no chrome.* deps (takes a tree arg) so it is unit-testable.
- `src/offscreen/offscreen.html` — offscreen document host page.
- `src/offscreen/offscreen.ts` — wires PGlite/Dexie; handles `db:query`/`db:count`/`ingest:start`; emits `ingest:progress`.
- `src/hooks/useBookmarkSearchTool.ts` — the `search_bookmarks` AgentTool + `BOOKMARK_SYSTEM_PROMPT`.
- `e2e/fixtures/bookmarks.ts` — seed fixtures (title/url; Phase 3 will add `html`).
- `e2e/search.spec.ts` — Phase 2 metadata-search e2e.
- `e2e/tests/pages/ExtChatPage.ts` already exists (Phase 1); extend it with `waitForIndexed`/`getToolCall` helpers.
- Test files: `src/db/dexie.test.ts`, `src/db/pglite.test.ts`, `src/services/sync.test.ts`, `src/services/indexer.test.ts`, `src/services/search.test.ts`, `src/lib/bookmarks.test.ts`, `src/lib/messages.test.ts`.

Modified:
- `manifest.json` — add `"offscreen"`, `"bookmarks"`, `"alarms"` permissions; add offscreen + pglite worker/wasm to `web_accessible_resources`.
- `src/background.ts` — `ensureOffscreen()`, bookmark enumeration on auth-ready, `chrome.bookmarks.on*` live updates, `chrome.alarms` re-poke, message relay.
- `src/hooks/useAgent.ts` — add optional `systemPrompt` param; set `agent.state.systemPrompt = systemPrompt`.
- `src/components/chat/ChatDemo.tsx` — merge `useBookmarkSearchTool()` into `tools`; pass `BOOKMARK_SYSTEM_PROMPT` to `useAgent`.
- `src/components/chat/MessageBubble.tsx` — render assistant text via `react-markdown` + `remark-gfm`.
- `vite.config.ts` — `optimizeDeps.exclude: ['@electric-sql/pglite']`, `worker: { format: 'es' }`, add the offscreen html input.
- `package.json` — add `@electric-sql/pglite@0.4.5`, `dexie@^4.0.10`, `react-markdown@^10`, `remark-gfm@^4`.

---

## Conventions used in this plan

- **Namespace**: every db/service fn takes `ns: string` (mirrors yt-chat's `sub`). The app passes the constant `NS = 'default'` (defined in `src/lib/messages.ts` and re-used). Threading the param keeps the multi-account door open without doing it now.
- **`DocumentRow`** columns (single source of truth in `pglite.ts`): `id, title, url, folder, content, date_added`. `content` (the only BM25-indexed text) = `` `${title} ${url} ${folder}` `` in Phase 2.
- **`CachedBookmark`** (Dexie, durable): `{ id, title, url, folderPath, dateAdded, contentHash, content?, contentHashFetched?, contentStatus, indexedAt }`. Phase 2 only writes/reads `id,title,url,folderPath,dateAdded,contentHash,indexedAt` and sets `contentStatus:'pending'`; the content* fields exist for Phase 3.
- **`indexedAt`**: `0` = needs (re)index; else epoch-ms. Drives incremental indexing.
- TypeBox: `import { Type, StringEnum } from '@mariozechner/pi-ai'`. Agent types: `import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'`.

---

## Task 1: Phase-2 build foundation + PGlite/CRXJS spike (gate)

Goal: install deps, declare Phase-2 manifest permissions, configure Vite for the PGlite worker/wasm, add the offscreen document, and **prove PGlite initializes and runs a query inside the offscreen doc under CRXJS** before building anything on it. This is the PRD's #1 risk — validate first.

**Files:** Modify `package.json`, `manifest.json`, `vite.config.ts`, `src/background.ts`; Create `src/offscreen/offscreen.html`, `src/offscreen/offscreen.ts` (temporary spike body, replaced in Task 5).

- [ ] **Step 1: Install deps**

```bash
npm i @electric-sql/pglite@0.4.5 dexie@^4.0.10 react-markdown@^10 remark-gfm@^4
```
Expected: installs cleanly. `@electric-sql/pglite` pinned to `0.4.5` to match the proven yt-chat version.

- [ ] **Step 2: Add Phase-2 permissions + web-accessible resources to `manifest.json`**

Replace `permissions` and `web_accessible_resources`:
```json
  "permissions": ["identity", "storage", "offscreen", "bookmarks", "alarms"],
  "host_permissions": ["https://main-id.getbodhi.app/*"],
  "web_accessible_resources": [
    { "resources": ["assets/*", "src/offscreen/offscreen.html"], "matches": ["<all_urls>"] }
  ]
```
(Do NOT add `<all_urls>` host permission — that is Phase 3. `assets/*` already covers CRXJS-emitted worker/wasm chunks.)

- [ ] **Step 3: Configure `vite.config.ts` for PGlite worker/wasm + offscreen input**

Add `optimizeDeps.exclude` and `worker.format`, and register the offscreen html so CRXJS emits it. Keep the existing vitest guard.
```ts
export default defineConfig({
  plugins: [react(), tailwindcss(), ...(process.env.VITEST ? [] : [crx({ manifest })])],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: { port: 45173, strictPort: true },
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  worker: { format: 'es' },
  build: {
    rollupOptions: {
      input: { index: 'index.html', offscreen: 'src/offscreen/offscreen.html' },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
```
Note: with CRXJS, offscreen html referenced from `web_accessible_resources` is usually picked up automatically; the explicit `input` is a belt-and-suspenders so the page is emitted even if not referenced by an `action`/`background` field.

- [ ] **Step 4: Create `src/offscreen/offscreen.html`**

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>bookmarks-chat offscreen</title></head>
  <body>
    <script type="module" src="./offscreen.ts"></script>
  </body>
</html>
```

- [ ] **Step 5: Create a temporary spike `src/offscreen/offscreen.ts`** (replaced in Task 5)

```ts
import { PGliteWorker } from '@electric-sql/pglite/worker';
import { live } from '@electric-sql/pglite/live';

async function spike() {
  const db = await PGliteWorker.create(
    new Worker(new URL('../db/pglite-worker.ts', import.meta.url), { type: 'module' }),
    { dataDir: 'idb://pglite-bookmarks-spike', extensions: { live } },
  );
  await db.waitReady;
  await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_textsearch;`);
  const res = await db.query<{ n: number }>('SELECT 1::int AS n');
  console.log('[offscreen-spike] pglite OK, SELECT 1 =', res.rows[0]?.n);
}
spike().catch((e) => console.error('[offscreen-spike] FAILED:', e));
```
Also create the worker now (needed by the spike): `src/db/pglite-worker.ts`:
```ts
import { PGlite } from '@electric-sql/pglite';
import { pg_textsearch } from '@electric-sql/pglite/pg_textsearch';
import { worker } from '@electric-sql/pglite/worker';

worker({
  async init(options) {
    return PGlite.create({
      ...options,
      extensions: { pg_textsearch },
      initialMemory: 128 * 1024 * 1024,
    });
  },
});
```

- [ ] **Step 6: Make the SW create the offscreen doc on install (temporary, for the spike)**

In `src/background.ts`, add a helper and call it on install:
```ts
async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('src/offscreen/offscreen.html'),
    reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.DOM_PARSER],
    justification: 'Owns PGlite + Dexie for local bookmark indexing and search.',
  });
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[bg] installed');
  void ensureOffscreen();
});
```
(Keep the existing `BodhiExtClient` init and `action.onClicked` handler.)

- [ ] **Step 7: Build**

```bash
npm run build
```
Expected: PASS. Confirm `dist/src/offscreen/offscreen.html` and a pglite worker chunk + a `.wasm` asset exist under `dist/`:
```bash
ls dist/src/offscreen/offscreen.html && find dist -name '*.wasm' -o -name '*pglite*'
```
If the build errors on the worker URL or wasm, apply the fallback: ensure the emitted worker `.js` and `.wasm` are matched by `web_accessible_resources` (broaden to `"assets/*"` already covers `dist/assets/*`; if CRXJS emits the worker elsewhere, add that path).

- [ ] **Step 8: Manual spike verification (one-time human/agent check)**

Load `dist/` unpacked (`chrome://extensions` → Load unpacked). Open the service worker's console (it creates the offscreen doc on install/reload). Then inspect the offscreen document console: `chrome://extensions` → the extension → "Inspect views: offscreen.html". **Expected log:** `[offscreen-spike] pglite OK, SELECT 1 = 1`. If instead you see a wasm/CSP/worker error, this is the gate — resolve before Task 2 (typical fixes: add the worker/wasm path to `web_accessible_resources`; confirm `worker.format='es'`; confirm `optimizeDeps.exclude`). Document the resolution in the commit message.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json manifest.json vite.config.ts src/offscreen src/db/pglite-worker.ts src/background.ts
git commit -m "feat(ext): Phase-2 build foundation + PGlite-in-offscreen spike (CRXJS)"
```

---

## Task 2: PGlite document store (`src/db/pglite.ts`)

Goal: the offscreen-owned BM25 store, ported from `YT/db/pglite.ts` with bookmark columns and a single `documents` table (no transcript table). Unit-tested in Node (PGlite runs in vitest without a worker by using the in-process schema via the same SQL).

**Files:** Create `src/db/pglite.ts`, `src/db/pglite.test.ts`.

- [ ] **Step 1: Write the failing test `src/db/pglite.test.ts`**

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { documentCount, optimizeBm25Index, query, recoverPGlite, upsertDocuments } from './pglite';

const NS = 'test';
afterEach(async () => { await recoverPGlite(NS); });

describe('pglite documents store', () => {
  it('upserts, counts, and BM25-ranks bookmarks', async () => {
    await upsertDocuments(NS, [
      { id: 'a', title: 'Rust async book', url: 'https://rust-lang.org/async', folder: 'Dev/Rust',
        content: 'Rust async book https://rust-lang.org/async Dev/Rust', date_added: 2 },
      { id: 'b', title: 'Cooking pasta', url: 'https://food.example/pasta', folder: 'Food',
        content: 'Cooking pasta https://food.example/pasta Food', date_added: 1 },
    ]);
    await optimizeBm25Index(NS);
    expect(await documentCount(NS)).toBe(2);

    const hits = await query<{ id: string }>(
      NS,
      `SELECT id FROM documents ORDER BY content <@> to_bm25query($1, 'idx_documents_bm25') LIMIT 5`,
      ['rust async'],
    );
    expect(hits[0]?.id).toBe('a');
  });

  it('upsert replaces on conflicting id', async () => {
    await upsertDocuments(NS, [{ id: 'a', title: 'v1', url: 'u', folder: '', content: 'v1 u', date_added: 1 }]);
    await upsertDocuments(NS, [{ id: 'a', title: 'v2', url: 'u', folder: '', content: 'v2 u', date_added: 1 }]);
    const rows = await query<{ title: string }>(NS, 'SELECT title FROM documents WHERE id=$1', ['a']);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('v2');
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`Cannot find module './pglite'`)

Run: `npx vitest run src/db/pglite.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/db/pglite.ts`**

Port `YT/db/pglite.ts` with these exact adaptations: single `documents` table with bookmark columns; drop the transcript table/functions and `kind`/`docId`. Use `dataDir: idb://pglite-bookmarks-${ns}`. In test/non-worker environments PGliteWorker still works (it spawns the worker); if the worker URL fails under vitest, fall back to a plain `PGlite` — but prefer the worker path to match runtime. Full file:
```ts
import { PGlite } from '@electric-sql/pglite';
import { pg_textsearch } from '@electric-sql/pglite/pg_textsearch';
import { live } from '@electric-sql/pglite/live';
import { PGliteWorker } from '@electric-sql/pglite/worker';

export interface DocumentRow {
  id: string;
  title: string;
  url: string;
  folder: string;
  content: string;
  date_added: number;
}

const DOCUMENT_COLUMNS = ['id', 'title', 'url', 'folder', 'content', 'date_added'] as const satisfies
  readonly (keyof DocumentRow)[];

const UPSERT_BATCH = 200;
const SCHEMA_VERSION = '1';

const DOCUMENTS_DDL = `
  CREATE TABLE IF NOT EXISTS documents (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL DEFAULT '',
    url         TEXT NOT NULL DEFAULT '',
    folder      TEXT NOT NULL DEFAULT '',
    content     TEXT NOT NULL DEFAULT '',
    date_added  BIGINT NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_documents_bm25
    ON documents USING bm25 (content)
    WITH (text_config='english', k1=1.2, b=0.75);
`;

const SCHEMA_SQL = `
  CREATE EXTENSION IF NOT EXISTS pg_textsearch;
  ${DOCUMENTS_DDL}
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')
    ON CONFLICT (key) DO NOTHING;
`;

export function buildPlaceholders(rowCount: number, cols: number): string {
  return Array.from({ length: rowCount }, (_, j) => {
    const offset = j * cols;
    return `(${Array.from({ length: cols }, (_, k) => `$${offset + k + 1}`).join(', ')})`;
  }).join(',');
}

type DbHandle = PGliteWorker | PGlite;
let current: { ns: string; promise: Promise<DbHandle> } | undefined;

function createDb(ns: string): Promise<DbHandle> {
  const dataDir = `idb://pglite-bookmarks-${ns}`;
  // In a worker-capable context (offscreen doc) use the worker; vitest/node falls back to in-process.
  try {
    return PGliteWorker.create(
      new Worker(new URL('./pglite-worker.ts', import.meta.url), { type: 'module' }),
      { dataDir, extensions: { live } },
    );
  } catch {
    return PGlite.create({ dataDir, extensions: { pg_textsearch } });
  }
}

async function openDb(ns: string): Promise<DbHandle> {
  const db = await createDb(ns);
  await db.waitReady;
  await db.exec(SCHEMA_SQL);
  await migrateSchema(db);
  await db.query('SELECT 1');
  return db;
}

async function migrateSchema(db: DbHandle): Promise<void> {
  const res = await db.query<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`);
  if (res.rows[0]?.value === SCHEMA_VERSION) return;
  await db.exec(`
    DROP TABLE IF EXISTS documents;
    ${DOCUMENTS_DDL}
    UPDATE meta SET value = '${SCHEMA_VERSION}' WHERE key = 'schema_version';
  `);
}

export function ensureDb(ns: string): Promise<DbHandle> {
  if (current?.ns === ns) return current.promise;
  if (current) {
    const prev = current.promise;
    void prev.then((db) => db.close()).catch(() => {});
    current = undefined;
  }
  const promise = (async () => {
    try {
      return await openDb(ns);
    } catch (err) {
      console.warn('PGlite init failed; deleting volume and rebuilding', err);
      await deleteVolume(ns);
      return await openDb(ns);
    }
  })();
  promise.catch(() => { if (current?.promise === promise) current = undefined; });
  current = { ns, promise };
  return promise;
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

async function deleteVolume(ns: string): Promise<void> {
  const marker = `pglite-bookmarks-${ns}`;
  const dbs = (await indexedDB.databases?.()) ?? [];
  await Promise.all(
    dbs.map((d) => d.name).filter((n): n is string => !!n && n.includes(marker)).map(deleteDatabase),
  );
}

export async function recoverPGlite(ns: string): Promise<void> {
  if (current?.ns === ns) {
    const prev = current.promise;
    current = undefined;
    try { await (await prev).close(); } catch { /* already broken */ }
  }
  await deleteVolume(ns);
}

export async function query<T>(ns: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await ensureDb(ns);
  const res = await db.query<T>(sql, params);
  return res.rows;
}

export async function upsertDocuments(ns: string, rows: DocumentRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = await ensureDb(ns);
  const columnList = DOCUMENT_COLUMNS.join(', ');
  const updateSet = DOCUMENT_COLUMNS.filter((c) => c !== 'id').map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const batch = rows.slice(i, i + UPSERT_BATCH);
    await db.transaction(async (tx) => {
      const placeholders = buildPlaceholders(batch.length, DOCUMENT_COLUMNS.length);
      const params = batch.flatMap((r) => DOCUMENT_COLUMNS.map((c) => r[c]));
      await tx.query(
        `INSERT INTO documents (${columnList}) VALUES ${placeholders}
         ON CONFLICT (id) DO UPDATE SET ${updateSet}`,
        params,
      );
    });
  }
}

export async function deleteDocuments(ns: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await ensureDb(ns);
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
  await db.query(`DELETE FROM documents WHERE id IN (${placeholders})`, ids);
}

export async function documentCount(ns: string): Promise<number> {
  const rows = await query<{ n: number }>(ns, 'SELECT COUNT(*)::int AS n FROM documents');
  return rows[0]?.n ?? 0;
}

export async function optimizeBm25Index(ns: string): Promise<void> {
  const db = await ensureDb(ns);
  await db.exec('REINDEX INDEX idx_documents_bm25');
  await db.exec('CHECKPOINT');
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `npx vitest run src/db/pglite.test.ts`
Expected: PASS (both cases). If `PGliteWorker.create` throws under vitest because `new Worker(new URL(...))` is unsupported in jsdom, the `catch` fallback to in-process `PGlite` handles it; confirm the test still passes. If `pg_textsearch`/`to_bm25query` is unavailable in the in-process fallback, switch the test environment for this file to node by adding `// @vitest-environment node` at the top and retry.

- [ ] **Step 5: Commit**

```bash
git add src/db/pglite.ts src/db/pglite.test.ts
git commit -m "feat(db): PGlite documents store with BM25 (bookmark columns)"
```

---

## Task 3: Dexie durable cache (`src/db/dexie.ts`)

Goal: the durable IndexedDB source of truth for bookmarks, with `contentHash` dedup and meta helpers. Ported from `YT/db/dexie.ts`, bookmark shape.

**Files:** Create `src/db/dexie.ts`, `src/db/dexie.test.ts`.

- [ ] **Step 1: Write the failing test `src/db/dexie.test.ts`**

```ts
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
      id: '1', title: 'T', url: 'https://x', folderPath: 'A/B', dateAdded: 5,
      contentHash: await contentHash('T', 'https://x', 'A/B'), contentStatus: 'pending', indexedAt: 0,
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
```
Install the test helper if missing: `npm i -D fake-indexeddb`.

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run src/db/dexie.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/db/dexie.ts`**

```ts
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

export interface MetaRow { key: string; value: number }

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
  if (current && current.ns !== ns) { current.db.close(); current = undefined; }
  if (!current) current = { ns, db: new BookmarksDexie(ns) };
  return current.db;
}

export function closeDexie(): void {
  if (current) { current.db.close(); current = undefined; }
}

export async function contentHash(title: string, url: string, folderPath: string): Promise<string> {
  const data = new TextEncoder().encode(`${title} ${url} ${folderPath}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getMeta(db: BookmarksDexie, key: string): Promise<number> {
  return (await db.meta.get(key))?.value ?? 0;
}
export async function setMeta(db: BookmarksDexie, key: string, value: number): Promise<void> {
  await db.meta.put({ key, value });
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run src/db/dexie.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/dexie.ts src/db/dexie.test.ts package.json package-lock.json
git commit -m "feat(db): Dexie durable bookmark cache + contentHash dedup"
```

---

## Task 4: Sync + indexer services (`src/services/sync.ts`, `src/services/indexer.ts`)

Goal: diff a fresh flattened bookmark list against Dexie (dedup by `contentHash`, cascade deletes to PGlite), and batch-index `indexedAt=0` rows into PGlite. Ported from `YT/services/cache.ts` (`diffRows`/`syncTable`) and `YT/services/indexer.ts`.

**Files:** Create `src/services/sync.ts`, `src/services/indexer.ts`, `src/services/sync.test.ts`, `src/services/indexer.test.ts`. Depends on `src/lib/bookmarks.ts` `BookmarkNode` type (Task 6 creates the flattener; define the type here to avoid a cycle — or import from `bookmarks.ts`). To keep ordering clean, define `BookmarkNode` in `src/lib/bookmarks.ts` now (just the type + flattener); Task 6 only adds the SW wiring.

- [ ] **Step 1: Create `src/lib/bookmarks.ts` (type + flattener) and its test**

`src/lib/bookmarks.ts`:
```ts
export interface BookmarkNode {
  id: string;
  title: string;
  url: string;
  folderPath: string;
  dateAdded: number;
}

interface RawNode {
  id: string;
  title: string;
  url?: string;
  dateAdded?: number;
  children?: RawNode[];
}

// Flatten a chrome.bookmarks tree to URL nodes, computing folderPath from ancestor titles.
export function flattenBookmarks(tree: RawNode[]): BookmarkNode[] {
  const out: BookmarkNode[] = [];
  const walk = (nodes: RawNode[], path: string[]): void => {
    for (const n of nodes) {
      if (n.url) {
        out.push({
          id: n.id,
          title: n.title ?? '',
          url: n.url,
          folderPath: path.join('/'),
          dateAdded: n.dateAdded ?? 0,
        });
      } else if (n.children) {
        // Skip the unnamed roots (root '0', 'Bookmarks Bar', 'Other') from the path when title is empty.
        walk(n.children, n.title ? [...path, n.title] : path);
      }
    }
  };
  walk(tree, []);
  return out;
}
```
`src/lib/bookmarks.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { flattenBookmarks } from './bookmarks';

describe('flattenBookmarks', () => {
  it('flattens url nodes with folder paths and skips folders', () => {
    const tree = [
      { id: '0', title: '', children: [
        { id: '1', title: 'Bookmarks Bar', children: [
          { id: '10', title: 'Dev', children: [
            { id: '100', title: 'Rust', url: 'https://rust-lang.org', dateAdded: 3 },
          ]},
          { id: '11', title: 'Direct', url: 'https://example.com', dateAdded: 2 },
        ]},
      ]},
    ];
    const flat = flattenBookmarks(tree);
    expect(flat).toEqual([
      { id: '100', title: 'Rust', url: 'https://rust-lang.org', folderPath: 'Bookmarks Bar/Dev', dateAdded: 3 },
      { id: '11', title: 'Direct', url: 'https://example.com', folderPath: 'Bookmarks Bar', dateAdded: 2 },
    ]);
  });
});
```
Run: `npx vitest run src/lib/bookmarks.test.ts` → expect PASS after creating the file (write test first, watch FAIL, then implement, then PASS).

- [ ] **Step 2: Write failing `src/services/sync.test.ts`**

```ts
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { closeDexie, getDexie } from '@/db/dexie';
import { diffRows, syncBookmarks } from './sync';

const NS = 'test';
beforeEach(async () => { closeDexie(); await getDexie(NS).delete(); });

describe('diffRows', () => {
  it('keeps indexedAt when hash unchanged, resets when changed, deletes vanished', () => {
    const fresh = [{ id: 'a', hash: 'h1' }, { id: 'b', hash: 'h2new' }];
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
```

- [ ] **Step 3: Run — expect FAIL**, then implement `src/services/sync.ts`:

```ts
import { type BookmarkNode } from '@/lib/bookmarks';
import { type CachedBookmark, contentHash, getDexie } from '@/db/dexie';
import { deleteDocuments } from '@/db/pglite';

interface FreshHashed { id: string; hash: string }
interface ExistingHashed { id: string; contentHash: string; indexedAt: number }

export function diffRows(
  fresh: FreshHashed[],
  existing: ExistingHashed[],
): { toPutIndexedAt: Map<string, number>; toDelete: string[] } {
  const existingById = new Map(existing.map((r) => [r.id, r]));
  const freshIds = new Set(fresh.map((f) => f.id));
  const toPutIndexedAt = new Map<string, number>();
  for (const f of fresh) {
    const prev = existingById.get(f.id);
    toPutIndexedAt.set(f.id, prev && prev.contentHash === f.hash ? prev.indexedAt : 0);
  }
  const toDelete = existing.filter((r) => !freshIds.has(r.id)).map((r) => r.id);
  return { toPutIndexedAt, toDelete };
}

export async function syncBookmarks(ns: string, nodes: BookmarkNode[]): Promise<void> {
  const db = getDexie(ns);
  const existing = await db.bookmarks.toArray();
  const hashed = await Promise.all(
    nodes.map(async (n) => ({ node: n, hash: await contentHash(n.title, n.url, n.folderPath) })),
  );
  const { toPutIndexedAt, toDelete } = diffRows(
    hashed.map((h) => ({ id: h.node.id, hash: h.hash })),
    existing.map((e) => ({ id: e.id, contentHash: e.contentHash, indexedAt: e.indexedAt })),
  );
  const existingById = new Map(existing.map((e) => [e.id, e]));
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
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run src/services/sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing `src/services/indexer.test.ts`**

```ts
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
```

- [ ] **Step 6: Run — expect FAIL**, then implement `src/services/indexer.ts`:

```ts
import { type CachedBookmark, getDexie } from '@/db/dexie';
import { type DocumentRow, optimizeBm25Index, recoverPGlite, upsertDocuments } from '@/db/pglite';

export const INDEX_BATCH = 200;

export function bookmarkToDoc(row: CachedBookmark): DocumentRow {
  const content = row.content
    ? `${row.title} ${row.url} ${row.folderPath} ${row.content}`
    : `${row.title} ${row.url} ${row.folderPath}`;
  return { id: row.id, title: row.title, url: row.url, folder: row.folderPath, content, date_added: row.dateAdded };
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
    await db.bookmarks.bulkPut(batch.map((r) => ({ ...r, indexedAt: now })));
    indexed += batch.length;
  }
  await optimizeBm25Index(ns);
  return indexed;
}

const chains = new Map<string, Promise<unknown>>();

export function indexPending(ns: string): Promise<number> {
  const prev = chains.get(ns) ?? Promise.resolve();
  const next = prev.then(() => runIndexPending(ns), () => runIndexPending(ns));
  chains.set(ns, next.catch(() => {}));
  return next;
}

export async function rebuildIndex(ns: string): Promise<void> {
  await recoverPGlite(ns);
  const db = getDexie(ns);
  await db.bookmarks.toCollection().modify({ indexedAt: 0 });
  await indexPending(ns);
}
```

- [ ] **Step 7: Run — expect PASS**

Run: `npx vitest run src/services/indexer.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/bookmarks.ts src/lib/bookmarks.test.ts src/services/sync.ts src/services/sync.test.ts src/services/indexer.ts src/services/indexer.test.ts
git commit -m "feat(services): bookmark sync (dedup/cascade) + batched PGlite indexer"
```

---

## Task 5: Search query (`src/services/search.ts`)

Goal: parameterized BM25 search over the `documents` table. Ported from `YT/services/search.ts` with bookmark columns (`folder` instead of `channel_title`/`kind`).

**Files:** Create `src/services/search.ts`, `src/services/search.test.ts`.

- [ ] **Step 1: Write failing `src/services/search.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { buildSearchQuery } from './search';

describe('buildSearchQuery', () => {
  it('uses BM25 relevance order when query present', () => {
    const { sql, args } = buildSearchQuery({ query: 'rust async' });
    expect(sql).toContain("to_bm25query");
    expect(sql).toContain('<@>');
    expect(args).toContain('rust async');
  });

  it('orders by date_added desc for recent sort or empty query', () => {
    expect(buildSearchQuery({ sort: 'recent', query: 'x' }).sql).toContain('date_added DESC');
    expect(buildSearchQuery({}).sql).toContain('date_added DESC');
  });

  it('adds folder ILIKE filter and clamps limit to 25', () => {
    const { sql, args } = buildSearchQuery({ folder: 'Dev', limit: 1000 });
    expect(sql).toContain('folder ILIKE');
    expect(args[args.length - 1]).toBe(25);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**, then implement `src/services/search.ts`:

```ts
import { query } from '@/db/pglite';

export interface SearchParams {
  query?: string;
  folder?: string;
  sort?: 'relevance' | 'recent';
  limit?: number;
}
export interface SearchHit {
  title: string;
  folder: string;
  dateAdded: number;
  url: string;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

export function buildSearchQuery(p: SearchParams): { sql: string; args: unknown[] } {
  const q = p.query?.trim();
  const folder = p.folder?.trim();
  const useRelevance = p.sort !== 'recent' && !!q;

  const where: string[] = [];
  const args: unknown[] = [];
  if (folder) {
    args.push(folder);
    where.push(`folder ILIKE '%' || $${args.length} || '%'`);
  }

  let orderBy: string;
  if (useRelevance) {
    args.push(q);
    orderBy = `content <@> to_bm25query($${args.length}, 'idx_documents_bm25')`;
  } else {
    orderBy = `date_added DESC`;
  }

  args.push(Math.min(p.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const sql = `
    SELECT title, folder, date_added AS "dateAdded", url
    FROM documents
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${orderBy}
    LIMIT $${args.length}`;
  return { sql, args };
}

export async function searchDocuments(ns: string, p: SearchParams): Promise<SearchHit[]> {
  const { sql, args } = buildSearchQuery(p);
  return query<SearchHit>(ns, sql, args);
}
```

- [ ] **Step 3: Run — expect PASS**

Run: `npx vitest run src/services/search.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/services/search.ts src/services/search.test.ts
git commit -m "feat(services): parameterized BM25 bookmark search query"
```

---

## Task 6: Message contract (`src/lib/messages.ts`)

Goal: a typed request/response protocol over `chrome.runtime` with a `requestId` Promise registry, plus the UI-side `queryOffscreen()` helper the tool uses. Pure-logic parts (id generation, registry resolve) are unit-tested; the chrome.runtime wiring is exercised by e2e.

**Files:** Create `src/lib/messages.ts`, `src/lib/messages.test.ts`.

- [ ] **Step 1: Write failing `src/lib/messages.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest';
import { __registry, NS, nextRequestId, resolvePending } from './messages';

describe('messages registry', () => {
  it('generates unique request ids', () => {
    expect(nextRequestId()).not.toBe(nextRequestId());
  });
  it('resolves a pending promise by requestId', async () => {
    const id = nextRequestId();
    const p = new Promise((resolve) => __registry.set(id, { resolve, reject: vi.fn() }));
    resolvePending(id, { ok: 1 });
    expect(await p).toEqual({ ok: 1 });
    expect(__registry.has(id)).toBe(false);
  });
  it('exports the default namespace', () => {
    expect(NS).toBe('default');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**, then implement `src/lib/messages.ts`:

```ts
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

// Install once per context (UI tab): resolve replies coming back from the offscreen doc.
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

// UI-side request/response. `ensureOffscreen` happens in the SW on receipt of these.
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
```

- [ ] **Step 3: Run — expect PASS**

Run: `npx vitest run src/lib/messages.test.ts`
Expected: PASS. (The chrome.runtime calls aren't exercised here; the exported pure helpers are.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/messages.ts src/lib/messages.test.ts
git commit -m "feat(lib): typed offscreen message contract + queryOffscreen helper"
```

---

## Task 7: Offscreen document handlers (`src/offscreen/offscreen.ts`)

Goal: replace the Task-1 spike with the real offscreen runtime — owns Dexie+PGlite, handles `ingest:start` (sync → index, emits progress), `db:query`, `db:count`.

**Files:** Modify `src/offscreen/offscreen.ts`. (No new unit test — covered by e2e; logic it calls is already unit-tested.)

- [ ] **Step 1: Replace `src/offscreen/offscreen.ts`**

```ts
import { getDexie } from '@/db/dexie';
import { documentCount } from '@/db/pglite';
import { indexPending } from '@/services/indexer';
import { searchDocuments } from '@/services/search';
import { syncBookmarks } from '@/services/sync';
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

async function runIngest(ns: string, nodes: Message extends never ? never : { id: string; title: string; url: string; folderPath: string; dateAdded: number }[]): Promise<void> {
  await syncBookmarks(ns, nodes);
  const total = nodes.length;
  emitProgress({ phase: 'metadata', done: 0, total, errors: 0 });
  const indexed = await indexPending(ns);
  emitProgress({ phase: 'metadata', done: indexed, total, errors: 0 });
}

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  // Default namespace; threaded through services for future multi-account.
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
```
Note: simplify the `runIngest` signature to `nodes: BookmarkNode[]` — import `BookmarkNode` from `@/lib/bookmarks` and use it; the verbose conditional type above is illustrative, replace with:
```ts
import type { BookmarkNode } from '@/lib/bookmarks';
async function runIngest(ns: string, nodes: BookmarkNode[]): Promise<void> { /* body as above */ }
```

- [ ] **Step 2: Build to typecheck**

Run: `npm run build`
Expected: PASS. Fix any type errors (esp. the `runIngest` signature note above; ensure `BookmarkNode` import).

- [ ] **Step 3: Commit**

```bash
git add src/offscreen/offscreen.ts
git commit -m "feat(offscreen): own PGlite/Dexie; handle db:query/db:count/ingest:start"
```

---

## Task 8: Service-worker orchestration (`src/background.ts`)

Goal: on auth-ready, enumerate `chrome.bookmarks`, ensure the offscreen doc, and post `ingest:start` with flattened nodes; relay `db:*` requests from the UI to the offscreen doc; refresh on `chrome.bookmarks.on*`; re-poke via `chrome.alarms`.

**Files:** Modify `src/background.ts`.

- [ ] **Step 1: Rewrite `src/background.ts`**

```ts
import { BodhiExtClient } from '@bodhiapp/bodhi-js-react-ext';
import { AUTH_CLIENT_ID, AUTH_SERVER_URL } from './env';
import { flattenBookmarks } from './lib/bookmarks';
import type { Message } from './lib/messages';

const client = new BodhiExtClient(AUTH_CLIENT_ID, { authServerUrl: AUTH_SERVER_URL });
client.init().catch((e: unknown) => console.error('[bg] BodhiExtClient init failed:', (e as Error).message));

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
});

async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('src/offscreen/offscreen.html'),
    reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.DOM_PARSER],
    justification: 'Owns PGlite + Dexie for local bookmark indexing and search.',
  });
}

let _ingestSeq = 0;
async function kickoffIngest(reason: string): Promise<void> {
  await ensureOffscreen();
  const tree = await chrome.bookmarks.getTree();
  const nodes = flattenBookmarks(tree as unknown as Parameters<typeof flattenBookmarks>[0]);
  _ingestSeq += 1;
  const msg: Message = { type: 'ingest:start', requestId: `bg-${_ingestSeq}`, payload: { reason, nodes } };
  await chrome.runtime.sendMessage(msg).catch((e) => console.warn('[bg] ingest:start failed', e));
}

// Relay db:* requests from the UI tab to the offscreen doc (ensures it exists first).
chrome.runtime.onMessage.addListener((msg: Message) => {
  if (msg && (msg.type === 'db:query' || msg.type === 'db:count')) {
    void ensureOffscreen();
  }
});

// Trigger ingestion when auth becomes ready.
let _ingested = false;
client.subscribe?.(() => {
  const state = client.getState?.();
  const ready = state && (state.isAuthenticated || state.status === 'authenticated');
  if (ready && !_ingested) {
    _ingested = true;
    void kickoffIngest('auth-ready');
  }
});

// Live bookmark updates → re-enumerate + re-index incrementally.
const refresh = () => { void kickoffIngest('bookmark-change'); };
chrome.bookmarks.onCreated.addListener(refresh);
chrome.bookmarks.onChanged.addListener(refresh);
chrome.bookmarks.onRemoved.addListener(refresh);
chrome.bookmarks.onMoved.addListener(refresh);

// Resume after SW suspension while work remains.
chrome.alarms.create('ingest-poke', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'ingest-poke') void ensureOffscreen(); });

chrome.runtime.onInstalled.addListener(() => console.log('[bg] installed'));
chrome.runtime.onStartup.addListener(() => void ensureOffscreen());
```
Note: `client.subscribe`/`getState` shape may differ — adapt to the actual `BodhiExtClient` API (mirror how `02-auth-migration.md` / `sdk-test-app/ext/src-ext/background.ts` observe auth state). If `BodhiExtClient` exposes no SW-side auth subscription, fall back to triggering `kickoffIngest` from the **UI** once `useBodhi().isAuthenticated` flips (send a `chrome.runtime` message `{type:'auth:state'}` the SW listens for). Verify against the installed package's types before finalizing.

- [ ] **Step 2: Build to typecheck**

Run: `npm run build`
Expected: PASS. Resolve `BodhiExtClient` API mismatches per the note (check `node_modules/@bodhiapp/bodhi-js-react-ext` types for the SW client's auth-observation API).

- [ ] **Step 3: Manual smoke (one-time)**

Load `dist/` unpacked, open the tab, log in. In the offscreen console expect `[offscreen] ready` then `ingest:progress`-driven logs; in the SW console expect `kickoffIngest` to run after auth. Add a real bookmark in the browser and confirm a `bookmark-change` re-ingest fires. (Defer if running headless; the e2e in Task 10 is the authoritative check.)

- [ ] **Step 4: Commit**

```bash
git add src/background.ts
git commit -m "feat(sw): enumerate bookmarks on auth-ready; offscreen + alarms orchestration"
```

---

## Task 9: UI — `search_bookmarks` tool, system prompt, markdown rendering

Goal: expose the local tool to the agent, set the bookmark-aware system prompt, and render assistant GFM tables.

**Files:** Create `src/hooks/useBookmarkSearchTool.ts`; Modify `src/hooks/useAgent.ts`, `src/components/chat/ChatDemo.tsx`, `src/components/chat/MessageBubble.tsx`.

- [ ] **Step 1: Create `src/hooks/useBookmarkSearchTool.ts`**

```ts
import { useMemo } from 'react';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { StringEnum, Type } from '@mariozechner/pi-ai';
import { queryOffscreen } from '@/lib/messages';
import type { SearchParams } from '@/services/search';

export const BOOKMARK_SYSTEM_PROMPT = `You are a helpful assistant for the user's browser bookmarks.

When the user asks to find, recall, or summarize bookmarks, call the \`search_bookmarks\` tool.
- For "latest"/"recent"/"newest", pass sort='recent'.
- For topical questions ("about X", "find ... on Y"), rely on relevance (default) via query.
- Use folder to narrow to a folder by name.

Present results as a GitHub-flavored Markdown table with columns: Title | Folder | Added | Link.
Render Link as a Markdown link to the row's url. If there are no results, say so plainly.`;

const parameters = Type.Object({
  query: Type.Optional(Type.String({ description: 'Free-text terms; ranked by BM25 relevance.' })),
  folder: Type.Optional(Type.String({ description: 'Filter to bookmarks whose folder path contains this text.' })),
  sort: Type.Optional(StringEnum(['relevance', 'recent'], {
    description: "'relevance' (default, needs query) or 'recent' (newest first).",
  })),
  limit: Type.Optional(Type.Number({ description: 'Max results (default 10, max 25).' })),
});

const DESCRIPTION =
  "Search the user's own browser bookmarks (title, URL, folder) indexed locally. Returns ranked " +
  'rows with title, folder, date added, and the URL. Present results as a GitHub-flavored Markdown table.';

function textResult(text: string): AgentToolResult<unknown> {
  return { content: [{ type: 'text', text }], details: null };
}

export function useBookmarkSearchTool(): AgentTool[] {
  return useMemo(() => {
    const tool: AgentTool = {
      name: 'search_bookmarks',
      label: 'search_bookmarks',
      description: DESCRIPTION,
      parameters,
      execute: async (_id: string, params: unknown): Promise<AgentToolResult<unknown>> => {
        const { documents } = await queryOffscreen('db:count', {});
        if (documents === 0) {
          return textResult('No bookmarks are indexed yet. Wait for indexing to finish and try again.');
        }
        const rows = await queryOffscreen('db:query', (params ?? {}) as SearchParams);
        if (rows.length === 0) return textResult('No matching bookmarks found.');
        return { content: [{ type: 'text', text: JSON.stringify(rows) }], details: rows };
      },
    };
    return [tool];
  }, []);
}
```

- [ ] **Step 2: Add a `systemPrompt` param to `useAgent.ts`**

Change the signature and the assignment. Find:
```ts
export function useAgent(tools: AgentTool[]) {
```
Replace with:
```ts
export function useAgent(tools: AgentTool[], systemPrompt = '') {
```
Find:
```ts
      agent.state.tools = toolsRef.current;
      agent.state.systemPrompt = '';
```
Replace with:
```ts
      agent.state.tools = toolsRef.current;
      agent.state.systemPrompt = systemPromptRef.current;
```
Add the ref + sync effect near `toolsRef`:
```ts
  const systemPromptRef = useRef<string>(systemPrompt);
  useEffect(() => { systemPromptRef.current = systemPrompt; }, [systemPrompt]);
```

- [ ] **Step 3: Merge the tool + prompt in `ChatDemo.tsx`**

Find:
```ts
  const tools = useMcpAgentTools({ enabledMcpTools, mcps, toolsByMcpId });
  const { ... } = useAgent(tools);
```
Replace the `tools` line and the `useAgent(tools)` call:
```ts
  const mcpTools = useMcpAgentTools({ enabledMcpTools, mcps, toolsByMcpId });
  const bookmarkTools = useBookmarkSearchTool();
  const tools = useMemo(() => [...bookmarkTools, ...mcpTools], [bookmarkTools, mcpTools]);
  // ... existing destructure ...
  const { /* same destructured names */ } = useAgent(tools, BOOKMARK_SYSTEM_PROMPT);
```
Add imports at the top of `ChatDemo.tsx`:
```ts
import { useMemo } from 'react';
import { BOOKMARK_SYSTEM_PROMPT, useBookmarkSearchTool } from '@/hooks/useBookmarkSearchTool';
```
(If `useMemo` is already imported, don't duplicate.)

- [ ] **Step 4: Render assistant markdown in `MessageBubble.tsx`**

Add imports:
```tsx
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
```
Find:
```tsx
        <div className="whitespace-pre-wrap break-words">{text}</div>
```
Replace with (render markdown for assistant, keep plain text for user):
```tsx
        {message.role === 'user' ? (
          <div className="whitespace-pre-wrap break-words">{text}</div>
        ) : (
          <div className="prose prose-sm dark:prose-invert max-w-none break-words [&_table]:w-full [&_th]:text-left [&_td]:border [&_th]:border [&_td]:px-2 [&_th]:px-2">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </div>
        )}
```
(Confirm `message.role` is in scope; the agent report shows `data-messagetype={message.role}` already used in this file, so it is.)

- [ ] **Step 5: Build + unit tests**

Run:
```bash
npm run build && npm test
```
Expected: build PASS; all unit tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useBookmarkSearchTool.ts src/hooks/useAgent.ts src/components/chat/ChatDemo.tsx src/components/chat/MessageBubble.tsx package.json package-lock.json
git commit -m "feat(ui): search_bookmarks tool + bookmark system prompt + GFM markdown rendering"
```

---

## Task 10: E2E — `search.spec.ts` (metadata search over seeded bookmarks)

Goal: seed bookmarks via the SW, log in for real, wait for indexing, ask a metadata question, and assert a `search_bookmarks` tool call + a seeded title rendered in a markdown table. Runs locally headed, then green in CI.

**Files:** Create `e2e/fixtures/bookmarks.ts`, `e2e/search.spec.ts`; Modify `e2e/tests/pages/ExtChatPage.ts`.

- [ ] **Step 1: Create `e2e/fixtures/bookmarks.ts`**

```ts
export interface BookmarkFixture { title: string; url: string }

export const BOOKMARK_FIXTURES: BookmarkFixture[] = [
  { title: 'Rust async programming guide', url: 'https://rust-lang.example/async' },
  { title: 'Tokio runtime internals', url: 'https://tokio.example/internals' },
  { title: 'Sourdough bread recipe', url: 'https://food.example/sourdough' },
  { title: 'Postgres full text search', url: 'https://pg.example/fts' },
];
// A query term that matches exactly one fixture's title (metadata match).
export const UNIQUE_TERM = 'Sourdough';
```

- [ ] **Step 2: Extend `ExtChatPage.ts` with indexing + tool-call helpers**

Add selectors and methods (the existing file from Phase 1 already has `openApp`/`login`/`loadModels`/`selectModel`/`send`/`waitForAssistantTurn`/`getAssistantText`):
```ts
  toolCall = '[data-testid="tool-call-message"]';

  // Poll db:count via the service worker → offscreen round-trip until >= expected.
  async waitForIndexed(context: import('@playwright/test').BrowserContext, expected: number): Promise<void> {
    let [sw] = context.serviceWorkers();
    sw ??= await context.waitForEvent('serviceworker');
    await expect
      .poll(
        async () =>
          sw.evaluate(
            () =>
              new Promise<number>((resolve) => {
                const requestId = `e2e-${Math.random()}`;
                const onMsg = (m: { type?: string; requestId?: string; payload?: { documents?: number } }) => {
                  if (m?.type === 'db:count:reply' && m.requestId === requestId) {
                    chrome.runtime.onMessage.removeListener(onMsg);
                    resolve(m.payload?.documents ?? 0);
                  }
                };
                chrome.runtime.onMessage.addListener(onMsg);
                chrome.runtime.sendMessage({ type: 'db:count', requestId, payload: {} });
                setTimeout(() => { chrome.runtime.onMessage.removeListener(onMsg); resolve(0); }, 2000);
              }),
          ),
        { timeout: 30000, intervals: [500, 1000, 2000] },
      )
      .toBeGreaterThanOrEqual(expected);
  }

  async expectToolCalled(): Promise<void> {
    await this.page.locator(this.toolCall).first().waitFor();
  }
```
(`expect` is already imported in the Phase-1 file; if not, add `import { expect } from '@playwright/test'`.)

- [ ] **Step 3: Create `e2e/search.spec.ts`**

```ts
import { test, expect } from '@playwright/test';
import { getTestState, FULL_MODEL_ID } from './tests/global-setup';
import { launchExtension } from './tests/utils/extension-context';
import { ExtChatPage } from './tests/pages/ExtChatPage';
import { BOOKMARK_FIXTURES, UNIQUE_TERM } from './fixtures/bookmarks';

test('search_bookmarks returns a seeded bookmark in a markdown table', async () => {
  const { bodhiServerUrl, username, password } = getTestState();
  const context = await launchExtension();
  try {
    // Seed bookmarks via the service worker BEFORE login so auth-ready enumeration picks them up.
    let [sw] = context.serviceWorkers();
    sw ??= await context.waitForEvent('serviceworker');
    await sw.evaluate(async (fixtures) => {
      const bar = '1'; // Bookmarks Bar
      const folder = await chrome.bookmarks.create({ parentId: bar, title: 'E2E' });
      for (const b of fixtures) await chrome.bookmarks.create({ parentId: folder.id, title: b.title, url: b.url });
    }, BOOKMARK_FIXTURES);

    const page = await context.newPage();
    const chat = new ExtChatPage(page);
    await chat.openApp(bodhiServerUrl);
    await chat.login(context, { username, password });

    await chat.waitForIndexed(context, BOOKMARK_FIXTURES.length);

    await chat.loadModels();
    await chat.selectModel(FULL_MODEL_ID);
    await chat.send(`search my bookmarks for ${UNIQUE_TERM} and show the results as a table`);
    await chat.waitForAssistantTurn(0);

    await chat.expectToolCalled();
    const reply = await chat.getAssistantText(0);
    expect(reply.toLowerCase()).toContain(UNIQUE_TERM.toLowerCase());
  } finally {
    await context.close();
  }
});
```

- [ ] **Step 4: Build + run e2e locally headed**

Run:
```bash
npm run build
HEADLESS=false npm run test:e2e
```
Expected: BOTH specs pass (`chat.spec.ts` + `search.spec.ts`). 2 passed.

Troubleshooting (resolve before CI):
- `waitForIndexed` times out → check the SW console: did `kickoffIngest` run after auth? Is the offscreen doc created? Is `db:count` reaching the offscreen doc (SW relay + offscreen listener)? Confirm `chrome.bookmarks.getTree()` returns the seeded nodes (seeding ran before login).
- Tool not called → the model may answer without the tool; make the prompt explicit ("call the search_bookmarks tool"). The system prompt already instructs table output.
- No table in output → confirm `react-markdown`+`remark-gfm` render (Task 9 Step 4); the assertion only checks the term text, but verify a table visually once.
- PGlite fails in the offscreen doc under headed Chromium → revisit Task 1 Step 8 gate (worker/wasm web-accessible resources).

- [ ] **Step 5: Commit**

```bash
git add e2e/fixtures/bookmarks.ts e2e/search.spec.ts e2e/tests/pages/ExtChatPage.ts
git commit -m "test(e2e): metadata search over seeded bookmarks (search_bookmarks + table)"
```

---

## Task 11: Green GitHub Actions run (definition of done)

Goal: push and confirm CI (build + unit + e2e under xvfb, both specs) is green — the gate that closes Phase 2.

**Files:** none expected (CI already runs `npm test` + e2e; `search.spec.ts` is picked up automatically).

- [ ] **Step 1: Confirm CI picks up both specs**

Read `.github/workflows/ci.yml`: the `E2E tests` step runs `npm run ci:test:e2e` (`playwright test`), which runs every `e2e/*.spec.ts` — so `search.spec.ts` runs with no change. Unit tests run via `npm run test`. No edits expected.

- [ ] **Step 2: Push**

```bash
git push origin main
```

- [ ] **Step 3: Watch to green**

```bash
RUN_ID=$(gh run list --workflow ci.yml --branch main --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status --interval 15
```
Expected: green (Lint, Build, Typecheck, Unit tests, **E2E tests** [both specs] ✓).

- [ ] **Step 4: If red, fix and repeat**

Common CI-only issues: PGlite worker/wasm not web-accessible under the packed extension (re-check Task 1 manifest), e2e flake in `waitForIndexed` (raise timeout / intervals), headless-vs-xvfb worker support (CI is ubuntu headed-under-xvfb — fine). **Phase 2 is done only when this run is green.**

---

## Self-review

**Spec coverage (vs `docs/prd/07` Phase 2 AC + docs 01/04/05/06):**
- Offscreen owns PGlite (+worker) & Dexie; single writer → Tasks 1, 2, 3, 7 (`01` data ownership).
- `db:count` round-trip when offscreen absent → ensured via SW relay `ensureOffscreen` (Task 8) + offscreen handler (Task 7); proven by `waitForIndexed` (Task 10).
- Metadata for **all** bookmarks; `db:count.documents === K` within seconds → Tasks 4 (sync+index), 8 (enumerate), 10 (assert) (`04` Stages 0–2, AC #1).
- `search_bookmarks` tool + BM25 + bookmark system prompt + GFM table → Tasks 5, 9 (`05`).
- Closing UI tab doesn't stop indexing → indexing runs in offscreen, triggered by SW (Tasks 7, 8) (`01`/`04` AC). (Not separately e2e-asserted in Phase 2; covered architecturally — note for manual check.)
- Live update (add bookmark at runtime searchable) → `chrome.bookmarks.on*` → `kickoffIngest` (Task 8) (`04` AC #3). (Manual smoke Task 8 Step 3.)
- Extended e2e green in CI → Tasks 10, 11 (`06`, `07` DoD).

**Placeholder scan:** No `TBD`/`later`/"add error handling". The two adaptation NOTES (Task 7 `runIngest` signature; Task 8 `BodhiExtClient` auth-observation API) are concrete "verify against installed types and use this fallback" instructions with the fallback shown — not vague placeholders, because the exact SW-side auth API of `BodhiExtClient` must be read from the installed package (it isn't knowable from the PRD). The PGlite/CRXJS empirical gate (Task 1 Step 8) has a stated expected log + concrete fixes.

**Type/name consistency:** `DocumentRow{id,title,url,folder,content,date_added}` is identical across `pglite.ts`, `indexer.ts` (`bookmarkToDoc`), `search.ts`. `CachedBookmark` fields identical across `dexie.ts`, `sync.ts`, `indexer.ts`. `BookmarkNode` identical across `bookmarks.ts`, `sync.ts`, `messages.ts`, `background.ts`, `offscreen.ts`. `queryOffscreen('db:count'|'db:query', …)` overloads match the offscreen reply types (`DbCountReply`/`SearchHit[]`). `NS='default'` used in `messages.ts`; offscreen/SW use the literal `'default'` (matches). `indexPending`/`rebuildIndex`/`searchDocuments`/`documentCount`/`recoverPGlite` names consistent between definition and call sites. e2e message shape `{type:'db:count',requestId,payload:{}}` ↔ offscreen `db:count` handler ↔ `db:count:reply` matches.

**Known empirical resolution points (each has an in-task verify + fallback):** PGlite worker+wasm under CRXJS (Task 1 Step 7–8, gate); `BodhiExtClient` SW auth subscription (Task 8 Step 1 note + UI-trigger fallback); `context.route`/offscreen fetch is Phase 3 (out of scope here); `expect.poll` round-trip selector for `db:count` in e2e (Task 10 Step 2, with 2s inner timeout).

---

## Out of scope (do NOT implement here)
Page-content fetch → `@mozilla/readability` → `turndown` → markdown; the `<all_urls>` host permission; content-phase resumable cursor/`fetchTimeoutMs`; the Phase-3 content-search e2e case. These are Phase 3 and will be planned separately. The `content`/`contentStatus`/`contentHashFetched` fields and the `bookmarkToDoc` content concatenation are already shaped so Phase 3 appends fetched markdown without a schema change.
```
