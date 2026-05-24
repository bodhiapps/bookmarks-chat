# 01 — Architecture

The extension runs across **three contexts**. Keeping responsibilities split this way is the
core architectural decision: it lets ingestion run in the background, keeps a single PGlite
writer, and matches MV3 constraints (the SW cannot reliably run WASM/DOM and is ephemeral).

```
┌─ Full-page tab  (chrome-extension://<fixed-id>/index.html) ──────────────┐
│  React app (existing src/) + BodhiProvider from @bodhiapp/bodhi-js-react-ext │
│  useBodhi (auth/models)   •   useAgent (pi-agent-core)                    │
│  search_bookmarks AgentTool ──"db:query" msg──┐                          │
│  ingestion status UI ◄────"ingest:progress" msg┤                         │
└───────────────────────────────────────────────┼─────────────────────────┘
                                                 │ chrome.runtime messaging
┌─ Service worker (src/background.ts) ────────────┼─────────────────────────┐
│  BodhiExtClient: OAuth (launchWebAuthFlow), companion discovery           │
│  Ingestion orchestrator: chrome.bookmarks events + chrome.alarms          │
│  ensureOffscreen(); relays db:* and ingest:* messages                     │
└───────────────────────────────────────────────┼─────────────────────────┘
                                                 │ chrome.runtime messaging
┌─ Offscreen document (src/offscreen/offscreen.html + offscreen.ts) ───────┐
│  OWNS PGlite (worker + pg_textsearch BM25)  +  Dexie (durable cache)       │
│  ingestion pipeline: fetch(url) → @mozilla/readability → turndown → upsert │
│  answers db:query / db:count ; emits ingest:progress                      │
└───────────────────────────────────────────────────────────────────────────┘
```

## Responsibilities

### Full-page tab (UI) — `index.html` + existing `src/`
- Renders the existing chat UI; auth via `useBodhi`; agent via `useAgent`.
- Hosts the `search_bookmarks` AgentTool, which **does not touch PGlite directly** — it sends
  a `db:query` message and awaits results (the offscreen doc is the only PGlite owner).
- Shows ingestion progress (subscribe to `ingest:progress`).
- Opened by the toolbar `action` (and as the OAuth completion target).

### Service worker — `src/background.ts`
- Instantiates and `init()`s `BodhiExtClient` (auth + companion discovery). See `02`.
- **Ingestion orchestration only** (no WASM/DOM): on auth-ready and on
  `chrome.bookmarks.onCreated/onChanged/onRemoved`, ensures the offscreen document exists and
  tells it to run/refresh ingestion. Uses `chrome.alarms` to resume after SW suspension.
- Relays messages between the UI tab and the offscreen document (both can also use
  `chrome.runtime.sendMessage` directly; route through the SW where a single coordination
  point helps — e.g. ensuring the offscreen doc exists before a `db:query`).

### Offscreen document — `src/offscreen/`
- **Sole owner** of PGlite (+ its worker) and Dexie. Created with
  `chrome.offscreen.createDocument({ url, reasons: ['WORKERS','DOM_PARSER'], justification })`.
  Only one offscreen document may exist at a time — guard creation with
  `chrome.offscreen.hasDocument()`.
- Runs the ingestion pipeline (see `04`): fetch page content, `@mozilla/readability`,
  `turndown`, upsert + BM25 index.
- Serves `db:query`, `db:count`, and emits `ingest:progress`.

## Message contract (`src/lib/messages.ts`)

Define a small typed protocol. All messages are `{ type, requestId?, payload }`.

| `type` | from → to | payload | reply |
|---|---|---|---|
| `db:query` | UI → offscreen | `SearchParams` (see `05`) | `SearchHit[]` |
| `db:count` | UI → offscreen | `{}` | `{ documents: number, pendingContent: number }` |
| `ingest:start` | SW → offscreen | `{ reason }` | `{ accepted: true }` |
| `ingest:progress` | offscreen → UI/SW | `{ phase, done, total, errors }` | — |
| `auth:state` | SW → UI | `AuthState` (optional; `useBodhi` may suffice) | — |

Implementation notes:
- Use `requestId` + a `Promise` registry to model request/response over `chrome.runtime`.
- Keep payloads structured-clone-safe (plain JSON). PGlite rows are plain objects already.
- The offscreen doc and UI tab share `src/db/*` and `src/services/*` code (same build), but at
  runtime only the offscreen instance opens PGlite. Guard with a context check so the UI never
  instantiates PGlite.

## Data ownership & integrity

- **Dexie = durable source of truth** (IndexedDB), **PGlite = derived BM25 index** rebuildable
  from Dexie (mirrors yt-chat `apps/web/src/db/pglite.ts`, `dexie.ts`).
- Single PGlite writer (offscreen) avoids "two PGlite instances on one `idb://` dataDir"
  corruption. If the UI ever needs counts, it asks via `db:count`.
- **Namespacing**: yt-chat namespaces stores by Google `sub`. For the extension, namespace by
  the Bodhi user id (from auth claims) if multi-account is desired, else a single fixed
  namespace (e.g. `default`). Keep the namespace param threaded through `src/db/*` like yt-chat.

## Lifecycle & resilience

- **SW suspension**: the SW is killed after ~30s idle. Persist ingestion cursor/progress in
  `chrome.storage.local`; re-arm `chrome.alarms` so ingestion resumes on the next wake.
- **Offscreen lifetime**: the offscreen doc stays alive while it has work/ports open; recreate
  it on demand (`ensureOffscreen()` before any `db:*` or `ingest:*`).
- **Bookmark live updates**: `chrome.bookmarks.onCreated/onChanged/onRemoved` → enqueue a Dexie
  upsert/delete + mark `indexedAt=0` (pending) → offscreen re-indexes incrementally.

## Acceptance criteria
- Opening the tab with the offscreen doc absent triggers `ensureOffscreen()` and a successful
  `db:count` round-trip.
- Closing the UI tab does **not** stop an in-progress ingestion (verify via `ingest:progress`
  continuing / `db:count` increasing while no tab is open).
- Killing the SW (devtools "stop") and waiting for an alarm resumes ingestion from the cursor.
