# PRD: `bookmarks-chat` → "Chat with your Bookmarks" Chrome Extension

> Audience: AI coding-assistant nodes implementing this conversion. Each linked doc is
> self-contained with concrete file paths, reference patterns, schemas, and acceptance
> criteria. Read this index first, then the doc for the phase you are implementing.

## 1. What we are building

Convert the current bare AI-chat SPA (`bookmarks-chat`, generated from `create-bodhi-js`)
into an **MV3 Chrome extension** where a Bodhi-served LLM answers questions over the user's
**browser bookmarks**.

After the user logs in to Bodhi, the extension ingests bookmarks **in the background**:
metadata (title/URL/folder) for **all** bookmarks, and fetched **page content converted to
markdown** for the most recent **~200**. Everything is indexed into in-browser **PGlite**
(BM25 full-text via `pg_textsearch`). A local `search_bookmarks` tool is exposed to the agent
so the user can ask, e.g. *"find my bookmarks about rust async"* and get a ranked markdown table.

## 2. Approved design decisions (do not relitigate)

| Decision                     | Choice                                                                           | Rationale                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Primary UI surface           | **Full-page tab** (`chrome-extension://<id>/index.html`)                         | Closest to current SPA; trivially e2e-navigable.                               |
| Background ingestion runtime | **Offscreen document**                                                           | Ingestion continues when the UI tab is closed; DOM + WASM + workers available. |
| v1 content scope             | **Metadata for all** + **page content for recent ~200**                          | Mirrors yt-chat's capped approach; bounded cost.                               |
| E2E OAuth                    | **Real OAuth** via `chrome.identity.launchWebAuthFlow`, mirroring `sdk-test-app` | User requirement; proven pattern.                                              |
| Repo/build structure         | **Convert flat app in-place** with `@crxjs/vite-plugin`                          | Least churn; keep existing `src/`.                                             |

## 3. Goals / Non-goals

**Goals**
- Extension shell with chat parity to today's app, authenticated via the Bodhi **extension** SDK.
- Background, gradual, resumable ingestion of bookmarks into PGlite with BM25 search.
- Page-content fetch → readability → markdown for recent bookmarks.
- A local `search_bookmarks` agent tool + bookmark-aware system prompt.
- Real-OAuth Playwright e2e with seeded bookmarks and stubbed page content.

**Non-goals (v1)**
- Cross-device sync of the index (PGlite is per-profile, local).
- Embeddings / semantic vector search (BM25 only for v1; pgvector is a later option).
- Editing/organizing bookmarks (read-only consumer of `chrome.bookmarks`).
- Side-panel/popup surfaces (full-page tab only).

## 4. Reference implementations (read these before coding)

Paths below are GitHub `owner/repo` plus an in-repo path. Throughout these docs, paths that
start with `bodhi-browser/` live in the **`BodhiSearch/bodhi-browser`** repo, `yt-chat/` in
**`bodhiapps/yt-chat`**, and unprefixed paths (`src/…`, `e2e/…`) in this repo
(**`bodhiapps/bookmarks-chat`**).

| What                                | Repo / in-repo path                                    | Use for                                                                |
| ----------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| Current app (target of conversion)  | `bodhiapps/bookmarks-chat` (this repo)                 | Existing chat/agent/MCP code to keep.                                  |
| YouTube + PGlite + ingestion + e2e  | `bodhiapps/yt-chat` → `apps/web`                       | PGlite/Dexie, indexer, search tool, fixture e2e.                       |
| Extension SDK + sample ext app      | `BodhiSearch/bodhi-browser` → `bodhi-js-sdk`           | `@bodhiapp/bodhi-js-react-ext`, `ExtUIClient`, `BodhiExtClient`.       |
| Sample ext app + **real-OAuth e2e** | `BodhiSearch/bodhi-browser` → `sdk-test-app/{ext,e2e}` | Manifest `key`, `launchWebAuthFlow`, two-extension Playwright harness. |
| Companion extension (loaded in e2e) | `BodhiSearch/bodhi-browser` → `bodhi-browser-ext/dist` | Second unpacked extension for e2e.                                     |

## 5. Glossary

- **SW** — the extension's MV3 background **service worker** (`background.ts`).
- **Offscreen document** — `chrome.offscreen` page that owns PGlite + runs ingestion.
- **Companion ext** — `bodhi-browser-ext`, the Bodhi browser extension the SDK talks to.
- **`ExtUIClient`** — UI-side Bodhi client (facade over companion-ext messaging or direct HTTP).
- **`BodhiExtClient`** — background-side Bodhi client (OAuth + companion discovery).
- **Document** — a row in PGlite `documents` (a bookmark's searchable record).

## 6. Document map

1. [`01-architecture.md`](./01-architecture.md) — the three contexts, message contract, data ownership, lifecycle.
2. [`02-auth-migration.md`](./02-auth-migration.md) — web→ext SDK swap, real OAuth flow, tokens, connection modes, env.
3. [`03-manifest-build-and-extension-id.md`](./03-manifest-build-and-extension-id.md) — CRXJS, manifest, fixed ID, redirect registration, Vite config.
4. [`04-ingestion-pipeline.md`](./04-ingestion-pipeline.md) — bookmarks→Dexie→offscreen→PGlite, content fetch→markdown, schema, resumability.
5. [`05-search-tool-and-agent.md`](./05-search-tool-and-agent.md) — `search_bookmarks` AgentTool, BM25 SQL, agent wiring, system prompt.
6. [`06-e2e-testing.md`](./06-e2e-testing.md) — two-extension Playwright harness, real OAuth, bookmark seeding, content stubs.
7. [`07-phasing-and-milestones.md`](./07-phasing-and-milestones.md) — three phases, tasks, acceptance criteria, risks.

## 7. Phasing at a glance

E2E is **woven through every phase**, not a final step. **A phase is done only when its e2e is
extended/adapted for that phase's feature and the GitHub Actions workflow (build + unit + e2e
under xvfb) is green on the pushed branch** — local green is not enough.

1. **Shell + auth + e2e harness + CI** — CRXJS + manifest + fixed ID; web→ext auth; chat parity
   in a full-page tab; establish the real-OAuth e2e harness + CI wiring; `chat.spec.ts` green in
   GitHub Actions.
2. **Index core + e2e** — offscreen PGlite/Dexie + metadata ingestion + `search_bookmarks` tool;
   extend e2e (seed bookmarks, metadata-search spec) → green in CI.
3. **Content + e2e** — fetch → readability → markdown for recent ~200; extend e2e (content
   fixtures, content-search case) → green in CI.

See [`07-phasing-and-milestones.md`](./07-phasing-and-milestones.md) for acceptance criteria.
