# 07 — Phasing & milestones

**Three phases**, each independently verifiable. Earlier phases unblock later ones.

> **Definition of done (applies to every phase):** the phase's feature work is complete **and**
> the end-to-end test has been **extended/adapted** to cover it **and** the change is **pushed to
> GitHub** where the **Actions workflow (`ci.yml`: build + unit + e2e under xvfb) is green**.
> "Passes locally" is **not** sufficient — each phase ends on a green CI run on the pushed
> branch. E2E is built and extended *within* each phase, never deferred to the end.

The e2e harness foundation (two-extension launch, real-OAuth login, in-process Bodhi server,
CI wiring) is established in **Phase 1** and **extended** in Phases 2–3. See `06`.

## Phase 1 — Extension shell + auth + e2e harness + green CI
**Docs:** `02`, `03`, `06`. **Goal:** chat parity as an MV3 extension, authenticated via the ext
SDK, proven by a real-OAuth e2e that is green in GitHub Actions.

Feature tasks:
- Add `@crxjs/vite-plugin`; create `manifest.json` (with `key`), `src/background.ts`; open UI as
  a full-page tab on `action.onClicked`.
- Generate the RSA key, compute `EXTENSION_ID`, commit the public key into `manifest.key`
  (gitignore `key.pem`).
- **Register `https://<EXTENSION_ID>.chromiumapp.org/callback`** for the app client (ops; blocks login).
- Swap `@bodhiapp/bodhi-js-react` → `@bodhiapp/bodhi-js-react-ext`; build `ExtUIClient` (UI) +
  `BodhiExtClient` (SW). Keep dev `defaultHost`.

E2E + CI tasks (establish the harness now):
- Build the harness (`06`): `launchWithExtensions` (app `dist/` + companion
  `bodhi-browser-ext/dist`), reuse the in-process Bodhi server `global-setup`, `ExtAuthPage` with
  the real `launchWebAuthFlow` login. Resolve companion-ext ↔ test-server wiring per
  `bodhi-browser/sdk-test-app/e2e` (fallback: direct mode).
- Port `e2e/chat.spec.ts` to navigate `chrome-extension://<EXTENSION_ID>/index.html`, log in for
  real, and assert a chat reply.
- Update `.github/workflows/ci.yml`: build the extension `dist/`, obtain the companion
  `bodhi-browser-ext/dist` (+ set `BODHI_EXT_DIST`), run e2e under xvfb (`HEADLESS=false`).

AC:
- Load unpacked → toolbar icon opens the tab → real OAuth (real Keycloak form + access-request
  approval, **no** `launchWebAuthFlow` stub) → models load → a chat reply streams.
- `npm run build` yields a `dist/` whose computed ID == `EXTENSION_ID`.
- `e2e/chat.spec.ts` green locally **and** on the pushed branch in **GitHub Actions** (build +
  unit + e2e all green).

## Phase 2 — Index core + e2e extended (metadata search) + green CI
**Docs:** `01`, `04` (Stages 0–2), `05`, `06`. **Goal:** all bookmarks metadata-searchable; agent
calls `search_bookmarks`; e2e extended to prove it; CI green.

Feature tasks:
- Add `src/offscreen/{offscreen.html,offscreen.ts}`; port `db/pglite*.ts`, `db/dexie.ts`,
  `services/indexer.ts`, `services/search.ts` from yt-chat (bookmark columns).
- Validate the PGlite worker + `.wasm` load under CRXJS (the known wrinkle in `03`).
- Implement the message contract (`src/lib/messages.ts`) + `ensureOffscreen()` in the SW.
- Enumerate `chrome.bookmarks` → Dexie → batched index into PGlite; `search_bookmarks` tool +
  bookmark system prompt; `react-markdown`/`remark-gfm` for tables.

E2E + CI tasks (extend the harness):
- Add bookmark seeding via `serviceWorker.evaluate(chrome.bookmarks.create)` (`06`).
- Add `e2e/search.spec.ts`: after login + ingestion, ask a metadata question and assert a
  `search_bookmarks` tool call + a seeded bookmark rendered in a markdown table.

AC:
- After login, `db:count.documents` equals the number of URL bookmarks within seconds.
- Closing the UI tab does not stop indexing; reopening shows the same `db:count`.
- `e2e/search.spec.ts` (metadata search over seeded bookmarks) green locally **and** in **GitHub
  Actions** on the pushed branch (full workflow green, alongside `chat.spec.ts`).

## Phase 3 — Content fetch → markdown + e2e extended (content search) + green CI
**Docs:** `04` (Stage 3), `06`. **Goal:** recent bookmarks searchable by page content; e2e
extended to prove content search; CI green.

Feature tasks:
- Add `@mozilla/readability` + `turndown`; implement sequential, throttled, resumable content
  fetch in the offscreen doc; cap content size; record per-URL errors.
- Persist cursor in `chrome.storage.local`; `chrome.alarms` to resume; `chrome.bookmarks.on*`
  live updates.

E2E + CI tasks (extend the harness):
- Stub bookmarked-page content via `context.route` returning fixture HTML (`06`); if interception
  misses the offscreen fetch, fall back to a local fixture HTTP server.
- Extend `e2e/search.spec.ts` (or add a case): a query matching only page **content** (not
  title/url) returns the right bookmark.

AC:
- Content fetched only for recent ~N; a failing URL doesn't block the queue (ends `error`).
- A query matching only page-content returns the right bookmark.
- SW-kill mid-content resumes without duplicate fetches / unnecessary re-indexing.
- The content-search e2e case is green locally **and** in **GitHub Actions** on the pushed branch
  (full workflow green).

## Cross-cutting risks & mitigations
- **PGlite under CRXJS/MV3** (worker + wasm + IndexedDB in offscreen): validate in Phase 2
  before building on it; fallback is adding worker/wasm to `web_accessible_resources`.
- **Companion-ext wiring to the test server** (needed for green CI from Phase 1): mirror
  `bodhi-browser/sdk-test-app/e2e`; fallback to direct mode. This is on the critical path because
  every phase requires a green e2e in CI.
- **`context.route` reaching offscreen fetches** (Phase 3): if interception misses, use a local
  fixture HTTP server.
- **Redirect-URI registration** (`chromiumapp.org/callback`): external, blocking for login and
  therefore for Phase 1's green CI — do it first.
- **CI runtime/flake**: extension e2e is headed-under-xvfb and heavier than the old SPA e2e; keep
  `workers: 1`, reuse Playwright browser cache, and budget for longer CI. A flaky e2e blocks the
  phase by definition, so invest in stable selectors/waits early.
- **`<all_urls>` permission**: broad; document in the store listing; only fetch from the
  offscreen/SW context, never inject content scripts for it.
- **`typecheck` is a no-op** in this repo — rely on `npm run build` for type errors; CI runs it.
