# 06 — E2E testing (real OAuth, MV3)

Replace the current `webServer` + `goto(localhost:45173)` model with a **persistent-context,
load-extension** harness that mirrors `sdk-test-app`'s real-OAuth flow. Keep the in-process
Bodhi server from the current `global-setup`.

> **E2E is not a final phase — it is built and extended within every phase** (see `07`). The
> harness below (launch, real OAuth, CI wiring) is established in **Phase 1** alongside
> `chat.spec.ts`; **Phase 2** extends it with bookmark seeding + a metadata-search spec; **Phase
> 3** extends it with content stubs + a content-search case. **A phase is done only when its
> extended e2e is green in GitHub Actions on the pushed branch** — not merely locally.

Primary references:
- `bodhi-browser/sdk-test-app/e2e/tests/utils/browser-manager.ts` (two-extension launch)
- `bodhi-browser/sdk-test-app/e2e/tests/pages/AuthSection.ts` (`loginWithAccessRequest` — the real OAuth)
- `bodhi-browser/sdk-test-app/e2e/tests/global-setup.ts` (in-process Bodhi server + `setupServerTestData`)
- current repo `e2e/tests/{global-setup.ts,utils/bodhi-server-manager.ts,pages/*}` (reuse)
- yt-chat `apps/web/e2e/search.spec.ts` + `pages/YouTubePage.ts` (fixture-stub assertions)

## Launching the extension(s) — `e2e/tests/utils/extension-context.ts`

```ts
import { chromium, type BrowserContext } from '@playwright/test';
const APP_DIST = path.resolve(__dirname, '../../../dist');   // our built extension
// Companion ext: build the bodhi-browser-ext repo, then point this at its dist via env.
// Default source: BodhiSearch/bodhi-browser repo → bodhi-browser-ext/dist
const COMPANION_DIST = process.env.BODHI_EXT_DIST!;          // required for e2e

export async function launchWithExtensions(userDataDir = ''): Promise<BrowserContext> {
  const exts = [COMPANION_DIST, APP_DIST].join(',');
  return chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',                       // new-headless path; or headed under xvfb in CI
    headless: false,                           // extensions need headed / new-headless
    args: [`--disable-extensions-except=${exts}`, `--load-extension=${exts}`],
  });
}
```
- Get the SW / IDs as needed: `context.serviceWorkers()` (MV3) → `sw.url().split('/')[2]`.
  We also hard-code `EXTENSION_ID` (from `03`) so we can `goto` directly.
- Headless: extensions are unsupported in classic headless; use `channel:'chromium'` or run
  headed under **xvfb** — the repo's CI already runs e2e under `xvfb-run` with `HEADLESS=false`,
  so CI is already compatible.

## Backend: keep the in-process Bodhi server

Reuse the existing `global-setup.ts` + `BodhiServerManager` (`@bodhiapp/app-bindings`) and the
`LoginPage`/`ApiModelsPage` helpers to start the server and `configureApiModel` (OpenAI). The
extension reaches this server via the **companion ext** (mirror sdk-test-app wiring) or, as a
fallback, `DirectExtClient` + `defaultHost` pointed at the test server port.

> Integration detail to mirror from sdk-test-app, not invent: how the companion `bodhi-browser-ext`
> is pointed at the test Bodhi server (port/initParams/`defaultHost`). Follow
> `sdk-test-app/e2e` (`browser-manager.ts` + `global-setup.ts` + how `ext.initParams` is passed).
> If companion wiring proves brittle, switch the app to direct mode for e2e (still real OAuth via
> `launchWebAuthFlow`) — the redirect URI and Keycloak steps are identical.

## Seeding realistic bookmarks

Seed via the service worker (deterministic; needs `bookmarks` permission), then let the
offscreen pipeline ingest them:

```ts
let [sw] = context.serviceWorkers(); sw ??= await context.waitForEvent('serviceworker');
await sw.evaluate(async (fixtures) => {
  const folder = await chrome.bookmarks.create({ parentId: '1', title: 'E2E' });
  for (const b of fixtures) await chrome.bookmarks.create({ parentId: folder.id, title: b.title, url: b.url });
}, BOOKMARK_FIXTURES);
```
Fixtures live in `e2e/fixtures/bookmarks/*.json` (title/url, plus an HTML body per URL for
content tests).

## Stubbing page content (for content-phase tests)

Like yt-chat stubs the YouTube API, stub the bookmarked URLs so readability→markdown is
deterministic. Note: the **offscreen document** issues these fetches, so route at the **context**
level (covers all pages/workers in the context):

```ts
for (const b of BOOKMARK_FIXTURES) {
  await context.route(b.url, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: b.html }));
}
```
(Confirm route interception reaches offscreen fetches; if a specific fetch context escapes
routing, fall back to a small fixture HTTP server and seed bookmark URLs pointing at it.)

## The real OAuth login helper — `e2e/tests/pages/ExtAuthPage.ts`

Port `AuthSection.loginWithAccessRequest`:
```ts
async login({ username, password }) {
  const popupPromise = this.context.waitForEvent('page');       // launchWebAuthFlow window
  await this.page.getByTestId('btn-auth-login').click();        // adapt to our login control
  const popup = await popupPromise; await popup.waitForLoadState('load');
  await popup.getByRole('button', { name: 'Login' }).click();
  await popup.fill('#username', username);
  await popup.fill('#password', password);
  await popup.click('#kc-login');
  const approve = popup.locator('[data-testid="review-approve-button"]');
  await approve.waitFor({ state: 'visible' });
  await approve.click();
  await this.page.locator('[data-testid="section-auth"][data-teststate="authenticated"]').waitFor();
}
```

## Tests (grown across phases)

1. **Phase 1** — `e2e/chat.spec.ts` (port): open `chrome-extension://<EXTENSION_ID>/index.html` →
   real login → load models → select model → ask "what day comes after monday" → assert
   "tuesday". (Auth + chat parity.) Must be green in GitHub Actions to close Phase 1.
2. **Phase 2** — `e2e/search.spec.ts` (new, yt-chat style): seed bookmarks via
   `serviceWorker.evaluate` → login → wait for ingestion (`db:count` ≥ K, or a UI "indexed"
   state) → ask "search my bookmarks for <fixture term> as a table" → assert a `search_bookmarks`
   tool call + a seeded title rendered in a markdown table (metadata match). Green in CI to close
   Phase 2.
3. **Phase 3** — extend `search.spec.ts` (or add a case): stub fixture **content** for a bookmark
   whose title/url do *not* contain the query term → assert the content-only query returns it.
   Green in CI to close Phase 3.

## Config & scripts
- `playwright.config.ts`: drop `webServer`; keep `globalSetup`. Tests build their own context via
  `launchWithExtensions`. Chromium project; `workers: 1`.
- Scripts: `test:e2e` must ensure `dist/` (and the companion `dist/`) are built first
  (`build` → `playwright test`). Document where the companion build comes from (build the
  `bodhi-browser-ext` repo, or point at a checked-in/prebuilt `dist`).

## Acceptance criteria (per phase)
- The phase's e2e (the spec(s) listed above for that phase) passes locally (headed) **and is
  green in GitHub Actions on the pushed branch** — local-only is not sufficient. CI green is the
  gate that closes the phase.
- The login step drives the **real** Keycloak form + access-request approval (no stubbing of
  `launchWebAuthFlow`).
- The search specs prove end-to-end: seeded bookmark → ingested → BM25-searchable → tool-called
  → rendered (metadata in Phase 2; page-content in Phase 3).
