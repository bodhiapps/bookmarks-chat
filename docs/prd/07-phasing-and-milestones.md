# 07 — Phasing & milestones

Five phases, each independently verifiable. Earlier phases unblock later ones. Each phase lists
tasks, the doc to follow, and acceptance criteria (AC).

## Phase 1 — Extension shell + auth migration
**Docs:** `02`, `03`. **Goal:** chat parity, running as an MV3 extension, authenticated via the
ext SDK.

Tasks:
- Add `@crxjs/vite-plugin`; create `manifest.json` (with `key`), `src/background.ts`; open UI as
  a full-page tab on `action.onClicked`.
- Generate the RSA key, compute `EXTENSION_ID`, commit the public key into `manifest.key`
  (gitignore `key.pem`).
- **Register `https://<EXTENSION_ID>.chromiumapp.org/callback`** for the app client (ops; blocks login).
- Swap `@bodhiapp/bodhi-js-react` → `@bodhiapp/bodhi-js-react-ext`; build `ExtUIClient` (UI) +
  `BodhiExtClient` (SW). Keep dev `defaultHost`.

AC:
- Load unpacked → toolbar icon opens the tab → real OAuth login succeeds → models load → a chat
  reply streams (manual parity with today's behavior).
- `npm run build` yields a `dist/` whose computed ID == `EXTENSION_ID`.

## Phase 2 — Index core (offscreen PGlite/Dexie + metadata + search tool)
**Docs:** `01`, `04` (Stages 0–2), `05`. **Goal:** all bookmarks metadata-searchable; agent can
call `search_bookmarks`.

Tasks:
- Add `src/offscreen/{offscreen.html,offscreen.ts}`; port `db/pglite*.ts`, `db/dexie.ts`,
  `services/indexer.ts`, `services/search.ts` from yt-chat (bookmark columns).
- Validate the PGlite worker + `.wasm` load under CRXJS (the known wrinkle in `03`).
- Implement the message contract (`src/lib/messages.ts`) + `ensureOffscreen()` in the SW.
- Enumerate `chrome.bookmarks` → Dexie → batched index into PGlite; `search_bookmarks` tool +
  bookmark system prompt; `react-markdown`/`remark-gfm` for tables.

AC:
- After login, `db:count.documents` equals the number of URL bookmarks within seconds.
- Manually asking to search returns a markdown table of matching bookmarks (relevance + recent).
- Closing the UI tab does not stop indexing; reopening shows the same `db:count`.

## Phase 3 — Content fetch → markdown (recent ~200)
**Doc:** `04` (Stage 3). **Goal:** recent bookmarks searchable by page content.

Tasks:
- Add `@mozilla/readability` + `turndown`; implement sequential, throttled, resumable content
  fetch in the offscreen doc; cap content size; record per-URL errors.
- Persist cursor in `chrome.storage.local`; `chrome.alarms` to resume; `chrome.bookmarks.on*`
  live updates.

AC:
- Content fetched only for recent ~N; a failing URL doesn't block the queue (ends `error`).
- A query matching only page-content (not title/url) returns the right bookmark.
- SW-kill mid-content resumes without duplicate fetches / unnecessary re-indexing.

## Phase 4 — E2E (real OAuth + seeding + content stubs)
**Doc:** `06`. **Goal:** automated proof of the whole flow.

Tasks:
- `launchWithExtensions` (app `dist/` + companion `bodhi-browser-ext/dist`); keep in-process
  Bodhi server `global-setup`.
- Port `ExtAuthPage` (real `launchWebAuthFlow` login); seed bookmarks via `serviceWorker.evaluate`;
  stub content via `context.route`.
- Port `chat.spec.ts`; add `search.spec.ts` (yt-chat assertion style).
- Resolve companion-ext ↔ test-server wiring by following `sdk-test-app/e2e` (fallback: direct mode).

AC:
- `chat.spec.ts` + `search.spec.ts` green locally (headed).
- Login uses the real Keycloak form + access-request approval (no `launchWebAuthFlow` stub).

## Phase 5 — CI
**Docs:** `06`, repo `.github/workflows/ci.yml`. **Goal:** e2e in CI.

Tasks:
- Build app `dist/` + obtain companion `dist/` in CI; run e2e under xvfb (`HEADLESS=false`,
  `xvfb-run`) — extend the existing CI e2e step.
- Cache Playwright browsers; upload artifacts on failure (already present).

AC:
- CI runs build + unit + e2e (both specs) green on push/PR.

## Cross-cutting risks & mitigations
- **PGlite under CRXJS/MV3** (worker + wasm + IndexedDB in offscreen): validate in Phase 2
  before building on it; fallback is adding worker/wasm to `web_accessible_resources`.
- **`context.route` reaching offscreen fetches**: if interception misses, use a local fixture
  HTTP server (Phase 4).
- **Companion-ext wiring to the test server**: mirror sdk-test-app; fallback to direct mode.
- **Redirect-URI registration** (`chromiumapp.org/callback`): external, blocking for login — do
  it in Phase 1.
- **`<all_urls>` permission**: broad; document in the store listing; only fetch from the
  offscreen/SW context, never inject content scripts for it.
- **`typecheck` is a no-op** in this repo — rely on `npm run build` for type errors.
