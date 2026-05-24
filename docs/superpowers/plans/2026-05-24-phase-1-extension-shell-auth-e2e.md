# Phase 1 — Extension shell + auth + e2e harness + green CI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the `bookmarks-chat` Vite SPA into a loadable MV3 Chrome extension that authenticates to Bodhi via the extension SDK and reaches chat parity, proven by a real-OAuth Playwright e2e (`chat.spec.ts`) that is **green in GitHub Actions**.

**Architecture:** Build the existing React app as an MV3 extension with `@crxjs/vite-plugin`. The UI runs in a full-page tab (`chrome-extension://<fixed-id>/index.html`) using `ExtUIClient` from `@bodhiapp/bodhi-js-react-ext`; a background service worker runs `BodhiExtClient` (OAuth via `chrome.identity.launchWebAuthFlow`) and opens the tab on toolbar click. In e2e, the extension connects to the existing in-process Bodhi server in **direct mode** via a `default-host` URL param (no companion extension needed for Phase 1), and login drives the real Keycloak flow in the `launchWebAuthFlow` popup.

**Tech Stack:** Vite + React 19 + TypeScript, `@crxjs/vite-plugin`, `@bodhiapp/bodhi-js-react-ext`, `@bodhiapp/app-bindings` (in-process Bodhi server for e2e), Playwright (`launchPersistentContext` + `--load-extension`), GitHub Actions + xvfb.

**Scope:** ONLY Phase 1 of `docs/prd/`. No PGlite, no offscreen document, no bookmarks ingestion, no `search_bookmarks` tool — those are Phases 2–3 and are explicitly out of scope here.

**Reference files (read before starting):** `docs/prd/02-auth-migration.md`, `docs/prd/03-manifest-build-and-extension-id.md`, `docs/prd/06-e2e-testing.md`. The proven extension patterns live in `BodhiSearch/bodhi-browser/sdk-test-app/{ext,e2e}`; quoted inline below where needed.

---

## File structure (created/modified in Phase 1)

- Create: `manifest.json` — MV3 manifest (Phase 1 permissions only) with fixed `key`.
- Create: `src/background.ts` — service worker: `BodhiExtClient.init()` + open tab on `action.onClicked`.
- Create: `key.pem` — RSA private key (gitignored, never committed).
- Modify: `vite.config.ts` — add `crx({ manifest })` (guarded off under vitest); drop `base`.
- Modify: `src/App.tsx` — `ExtUIClient` + `BodhiProvider client={...}`; parse `default-host` / `ext.initParams`.
- Modify: `src/env.ts` — unchanged values, but ensure `AUTH_SERVER_URL` is required (used by `ExtUIClient`).
- Modify: `package.json` — add `@crxjs/vite-plugin`, `@types/chrome`; remove `@bodhiapp/bodhi-js-react`, add `@bodhiapp/bodhi-js-react-ext`.
- Modify: `tsconfig.node.json` — `resolveJsonModule: true` (for `import manifest from './manifest.json'`).
- Modify: `.gitignore` — ignore `key.pem`.
- Create: `e2e/tests/utils/extension-context.ts` — `launchExtension()` + `EXTENSION_ID` constant.
- Create: `e2e/tests/pages/ExtChatPage.ts` — extension page object (open via default-host, real-OAuth login, chat).
- Modify: `e2e/chat.spec.ts` — drive the extension instead of the web SPA.
- Modify: `playwright.config.ts` — remove `webServer`; keep `globalSetup`.
- Modify: `.github/workflows/ci.yml` — ensure `build` precedes e2e (already true); confirm green.

`e2e/tests/global-setup.ts`, `e2e/tests/utils/bodhi-server-manager.ts`, `e2e/tests/pages/LoginPage.ts`, `e2e/tests/pages/ApiModelsPage.ts` are **reused unchanged**.

---

## Task 1: Extension build skeleton (CRXJS + manifest + fixed ID)

Goal: the app builds as an MV3 extension, loads unpacked, and renders the existing UI. Auth still on the old web client for now (swapped in Task 2).

**Files:**
- Create: `manifest.json`
- Create: `src/background.ts`
- Create: `key.pem` (gitignored)
- Create: `e2e/tests/utils/extension-context.ts` (the `EXTENSION_ID` constant lands here)
- Modify: `vite.config.ts`, `tsconfig.node.json`, `.gitignore`, `package.json`

- [ ] **Step 1: Install build deps**

Run:
```bash
npm i -D @crxjs/vite-plugin @types/chrome
```
Expected: installs without peer-dependency errors. If `@crxjs/vite-plugin` reports it does not support the installed Vite (repo is on Vite 8), pin the proven combo from `sdk-test-app/ext` and retry:
```bash
npm i -D @crxjs/vite-plugin@^2.0.0-beta.23 vite@^7.1.12 @vitejs/plugin-react@^5.1.2
```
(Resolve any vitest peer warning by keeping `vitest` on its current major; if `vitest` hard-requires Vite 8, keep Vite 8 and instead install the latest CRXJS that lists Vite 8 support — check `npm view @crxjs/vite-plugin peerDependencies`.)

- [ ] **Step 2: Generate the RSA key and compute the fixed extension ID**

Run:
```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out key.pem
echo "MANIFEST KEY:"; openssl rsa -in key.pem -pubout -outform DER 2>/dev/null | openssl base64 -A; echo
echo "EXTENSION ID:"; openssl rsa -in key.pem -pubout -outform DER 2>/dev/null | shasum -a 256 | head -c32 | tr 0-9a-f a-p; echo
```
Expected: prints a long base64 string (the manifest `key`) and a 32-char a–p id (the `EXTENSION_ID`). Record both.

- [ ] **Step 3: Gitignore the private key**

Add to `.gitignore` (under the env section):
```
# Extension signing key — never commit
key.pem
```

- [ ] **Step 4: Create `manifest.json`** (paste the base64 from Step 2 into `key`)

```json
{
  "manifest_version": 3,
  "name": "Bookmarks Chat",
  "version": "0.1.0",
  "description": "Chat with your browser bookmarks.",
  "key": "PASTE_BASE64_DER_PUBLIC_KEY_FROM_STEP_2",
  "action": { "default_title": "Open Bookmarks Chat" },
  "background": { "service_worker": "src/background.ts", "type": "module" },
  "permissions": ["identity", "storage"],
  "host_permissions": ["https://main-id.getbodhi.app/*"],
  "web_accessible_resources": [
    { "resources": ["assets/*"], "matches": ["<all_urls>"] }
  ]
}
```
(Phase-1 permissions only. `bookmarks`/`offscreen`/`alarms`/`<all_urls>` are added in later phases.)

- [ ] **Step 5: Create `src/background.ts`**

```ts
import { BodhiExtClient } from '@bodhiapp/bodhi-js-react-ext';
import { AUTH_CLIENT_ID, AUTH_SERVER_URL } from './env';

const client = new BodhiExtClient(AUTH_CLIENT_ID, { authServerUrl: AUTH_SERVER_URL });
client.init().catch((e: unknown) => {
  console.error('[bg] BodhiExtClient init failed:', (e as Error).message);
});

// Open the chat as a full-page tab when the toolbar icon is clicked.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
});

chrome.runtime.onInstalled.addListener(() => console.log('[bg] installed'));
```
Note: `BodhiExtClient` / `AUTH_SERVER_URL` come online in Task 2's dependency swap; Step 7 builds after that swap is unnecessary because Task 2 follows — to keep this task self-contained, if the package is not yet installed, do Task 2 Step 1 (dependency swap) first. (Recommended: run Task 2 Step 1 now, then continue.)

- [ ] **Step 6: Update `vite.config.ts`** (add CRXJS, guard it off under vitest, drop `base`)

```ts
/// <reference types="vitest/config" />
import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // crx() rewrites index.html/manifest; exclude it from the vitest run.
    ...(process.env.VITEST ? [] : [crx({ manifest })]),
  ],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: { port: 45173, strictPort: true },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
```

- [ ] **Step 7: Allow JSON import in the node tsconfig**

In `tsconfig.node.json`, add `"resolveJsonModule": true` inside `compilerOptions` and include the manifest:
```json
    "noUncheckedSideEffectImports": true,
    "resolveJsonModule": true
  },
  "include": ["vite.config.ts", "manifest.json"]
```

- [ ] **Step 8: Create `e2e/tests/utils/extension-context.ts`** (paste the id from Step 2 into `EXTENSION_ID`)

```ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// e2e/tests/utils -> repo root /dist
export const APP_DIST = path.resolve(__dirname, '../../../dist');

// Fixed extension id derived from manifest.key (see plan Task 1, Step 2).
export const EXTENSION_ID = 'PASTE_EXTENSION_ID_FROM_STEP_2';

const isCI = process.env.CI === 'true';

function headlessMode(): boolean {
  if (process.env.HEADLESS === 'false') return false;
  if (process.env.HEADLESS === 'true') return true;
  if (!isCI) return false; // local: headed
  return process.platform !== 'linux'; // linux CI: headed under xvfb; other CI: new-headless
}

export async function launchExtension(): Promise<BrowserContext> {
  if (!fs.existsSync(path.join(APP_DIST, 'manifest.json'))) {
    throw new Error(`Extension not built. Run \`npm run build\` first (missing ${APP_DIST}/manifest.json).`);
  }
  const headless = headlessMode();
  return chromium.launchPersistentContext('', {
    headless,
    args: [
      '--no-sandbox',
      '--mute-audio',
      `--disable-extensions-except=${APP_DIST}`,
      `--load-extension=${APP_DIST}`,
    ],
    // Chrome's new headless is required to load extensions headless; linux CI runs headed (xvfb).
    ...(headless && process.platform !== 'linux' ? { channel: 'chromium' } : {}),
  });
}
```

- [ ] **Step 9: Build and verify the dist + computed id**

Run:
```bash
npm run build
echo "computed id:"; openssl rsa -in key.pem -pubout -outform DER 2>/dev/null | shasum -a 256 | head -c32 | tr 0-9a-f a-p; echo
ls dist/manifest.json dist/index.html
```
Expected: build succeeds; `dist/manifest.json` and `dist/index.html` exist; the computed id matches the `EXTENSION_ID` you pasted. If `vite build` errors on the JSON import, confirm Step 7. If CRXJS errors, apply the version fallback in Step 1.

- [ ] **Step 10: Manually load + smoke-check (one-time human/agent check)**

Load `dist/` via `chrome://extensions` → "Load unpacked"; confirm the toolbar icon opens a tab at `chrome-extension://<EXTENSION_ID>/index.html` and the app header renders. Confirm the id in the URL equals `EXTENSION_ID`.

- [ ] **Step 11: Commit**

```bash
git add manifest.json src/background.ts vite.config.ts tsconfig.node.json .gitignore package.json package-lock.json e2e/tests/utils/extension-context.ts
git commit -m "feat(ext): build bookmarks-chat as an MV3 extension (CRXJS + fixed id)"
```

---

## Task 2: Migrate auth to the extension SDK (`ExtUIClient` + `BodhiExtClient`)

Goal: the UI uses `ExtUIClient`; it accepts a `default-host` URL param (e2e) and `ext.initParams`; the dev dead-host default is preserved.

**Files:**
- Modify: `package.json` (dependency swap)
- Modify: `src/App.tsx`
- Modify: `src/env.ts`

- [ ] **Step 1: Swap the SDK dependency**

Run:
```bash
npm rm @bodhiapp/bodhi-js-react
npm i @bodhiapp/bodhi-js-react-ext@latest
```
Expected: `@bodhiapp/bodhi-js-react-ext` appears in `package.json` dependencies. (Match the version line used by the rest of the Bodhi packages if a specific version is required; `@latest` is fine.)

- [ ] **Step 2: Ensure `AUTH_SERVER_URL` is required in `src/env.ts`**

`ExtUIClient` needs the realm URL. Replace the body of `src/env.ts` with:
```ts
// Environment variables with build-time validation
const AUTH_CLIENT_ID = import.meta.env.VITE_BODHI_APP_CLIENT_ID;
const AUTH_SERVER_URL = import.meta.env.VITE_BODHI_AUTH_SERVER_URL;

if (!AUTH_CLIENT_ID) {
  throw new Error(
    'VITE_BODHI_APP_CLIENT_ID is required. Register your app on https://developer.getbodhi.app ' +
      'and set it in .env (copy from .env.example).'
  );
}
if (!AUTH_SERVER_URL) {
  throw new Error('VITE_BODHI_AUTH_SERVER_URL is required (e.g. https://main-id.getbodhi.app/realms/bodhi).');
}

export { AUTH_CLIENT_ID, AUTH_SERVER_URL };
```

- [ ] **Step 3: Rewrite `src/App.tsx` to use `ExtUIClient`**

```tsx
import { useEffect, useMemo, useRef } from 'react';
import { BodhiProvider, useBodhi, BodhiBadge, ExtUIClient } from '@bodhiapp/bodhi-js-react-ext';
import { Toaster } from '@/components/ui/sonner';
import { AUTH_CLIENT_ID, AUTH_SERVER_URL } from './env';
import Layout from './components/Layout';

function parseExtInitParams():
  | { extension?: { timeoutMs?: number; attempts?: number; attemptWaitMs?: number; attemptTimeout?: number } }
  | undefined {
  const raw = new URLSearchParams(window.location.search).get('ext.initParams');
  if (!raw) return undefined;
  try {
    return JSON.parse(decodeURIComponent(raw));
  } catch (e) {
    console.warn('[App] Failed to parse ext.initParams:', e);
    return undefined;
  }
}

function parseDefaultHost(): string | undefined {
  const param = new URLSearchParams(window.location.search).get('default-host');
  if (param) return param;
  // Dev: point the auto-probe at a dead port so a developer's local Bodhi App isn't auto-used.
  return import.meta.env.DEV ? 'http://localhost:55311' : undefined;
}

function AppContent() {
  const { clientState, showSetup } = useBodhi();
  const hasAutoOpenedRef = useRef(false);

  useEffect(() => {
    const shouldAutoOpen =
      clientState.status === 'direct-not-connected' || clientState.status === 'extension-not-found';
    if (shouldAutoOpen && !hasAutoOpenedRef.current) {
      showSetup();
      hasAutoOpenedRef.current = true;
    }
  }, [clientState.status, showSetup]);

  return (
    <>
      <Layout />
      <Toaster />
    </>
  );
}

function App() {
  const defaultHost = useMemo(() => parseDefaultHost(), []);
  const client = useMemo(
    () =>
      new ExtUIClient(AUTH_CLIENT_ID, {
        authServerUrl: AUTH_SERVER_URL,
        logLevel: 'warn',
        initParams: parseExtInitParams(),
      }),
    []
  );

  return (
    <BodhiProvider client={client} {...(defaultHost !== undefined ? { defaultHost } : {})}>
      <AppContent />
      <div className="fixed bottom-4 right-6 z-50">
        <BodhiBadge size="md" variant="light" />
      </div>
    </BodhiProvider>
  );
}

export default App;
```

- [ ] **Step 4: Build to verify types + bundling**

Run:
```bash
npm run build
```
Expected: PASS. `build` is the real type check in this repo (`typecheck` is a no-op — see `docs/prd`). If a type error mentions `ExtUIClient`/`BodhiProvider` props, confirm `@bodhiapp/bodhi-js-react-ext` exports them (it does per `sdk-test-app/ext/src/App.tsx`).

- [ ] **Step 5: Resolve the setup-modal asset (verify, only if needed)**

Load `dist/` unpacked and open the tab with a live host param, e.g.
`chrome-extension://<EXTENSION_ID>/index.html?default-host=http://localhost:1135` (any value).
Open the service-worker + page console. If you see a failed request for a `setup-modal*.html` web-accessible resource, mirror `sdk-test-app/ext/manifest.json`: add the modal html paths to `web_accessible_resources.resources` and a `"sandbox": { "pages": [...] }` block, and ensure the SDK's modal html is emitted into `dist/` (check `node_modules/@bodhiapp/bodhi-js-react-ext` / `bodhi-js-core` for the html and add it to `public/` if CRXJS doesn't copy it). If no such error appears (happy path with `default-host` auto-connect never opens the modal), leave the manifest as-is.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/App.tsx src/env.ts manifest.json
git commit -m "feat(ext): migrate auth to ExtUIClient/BodhiExtClient (bodhi-js-react-ext)"
```

---

## Task 3: Register the extension OAuth redirect URI (ops — blocking)

Goal: the fixed extension's `chromiumapp.org` callback is an allowed redirect URI for the app client, so real OAuth succeeds. This mirrors the earlier `localhost:45173/callback` registration.

**Files:** none (external configuration).

- [ ] **Step 1: Register the redirect URI**

For the Bodhi app client `VITE_BODHI_APP_CLIENT_ID` (value in `.env.local`; currently `bodhi-app-f181a4d1-d7af-43f4-965a-0a8efd453d86`) on `https://main-id.getbodhi.app`, add this valid redirect URI:
```
https://<EXTENSION_ID>.chromiumapp.org/callback
```
(Use the `EXTENSION_ID` from Task 1, Step 2.) This is a developer-portal / Keycloak action performed by the human operator — the agent cannot do it. **The e2e in Task 5 cannot pass until this is done** (Keycloak otherwise returns "Invalid parameter: redirect_uri").

- [ ] **Step 2: Confirm**

Have the operator confirm the redirect URI is saved for that client. No commit.

---

## Task 4: E2E page object for the extension (real-OAuth login)

Goal: a page object that opens the extension in direct mode and performs the real Keycloak login inside the `launchWebAuthFlow` popup.

**Files:**
- Create: `e2e/tests/pages/ExtChatPage.ts`

- [ ] **Step 1: Create `e2e/tests/pages/ExtChatPage.ts`**

```ts
import { type BrowserContext, type Page, expect } from '@playwright/test';
import { EXTENSION_ID } from '../utils/extension-context';

export class ExtChatPage {
  constructor(private page: Page) {}

  selectors = {
    appTitle: '[data-testid="app-title"]',
    loginButton: '[data-testid="btn-auth-login"]',
    authenticated: '[data-testid="section-auth"][data-teststate="authenticated"]',
    clientReady: '[data-testid="badge-client-status"][data-teststate="ready"]',
    serverReady: '[data-testid="badge-server-status"][data-teststate="ready"]',
    refreshModels: '[data-testid="btn-refresh-models"]',
    modelSelector: '[data-testid="model-selector"]',
    modelSearchInput: '[data-testid="model-search-input"]',
    chatInput: '[data-testid="chat-input"]',
    sendButton: '[data-testid="send-button"]',
    chatProcessing: '[data-testid="chat-processing"]',
    message: (turn: number, role: string) =>
      `[data-testid="chat-message-turn-${turn}"][data-messagetype="${role}"]`,
  };

  // Open the extension tab in direct mode pointed at the in-process server, with a
  // fast extension-discovery timeout so the facade falls straight through to direct mode.
  async openApp(bodhiServerUrl: string): Promise<void> {
    const initParams = encodeURIComponent(
      JSON.stringify({ extension: { timeoutMs: 500, attempts: 1, attemptWaitMs: 50, attemptTimeout: 100 } })
    );
    const url =
      `chrome-extension://${EXTENSION_ID}/index.html` +
      `?default-host=${encodeURIComponent(bodhiServerUrl)}&ext.initParams=${initParams}`;
    await this.page.goto(url);
    await this.page.locator(this.selectors.appTitle).waitFor();
    await this.page.locator(this.selectors.clientReady).waitFor();
    await this.page.locator(this.selectors.serverReady).waitFor();
  }

  // Real OAuth: clicking login triggers chrome.identity.launchWebAuthFlow, which opens a
  // popup page. Drive the real Keycloak form + access-request approval there.
  async login(context: BrowserContext, creds: { username: string; password: string }): Promise<void> {
    const popupPromise = context.waitForEvent('page');
    await this.page.locator(this.selectors.loginButton).click();
    const popup = await popupPromise;
    await popup.waitForLoadState('load');

    // Bodhi-branded login page → Keycloak
    await popup.getByRole('button', { name: 'Login', exact: true }).click();
    await popup.waitForSelector('#username');
    await popup.fill('#username', creds.username);
    await popup.fill('#password', creds.password);
    await popup.click('#kc-login');

    // Access-request review: uncheck every MCP toggle so approve isn't gated on MCP
    // instances existing on the server, then approve (role-only).
    const approve = popup.getByTestId('review-approve-button');
    await approve.waitFor();
    const mcpToggles = popup.locator('[data-testid^="review-mcp-toggle-"]');
    const count = await mcpToggles.count();
    for (let i = 0; i < count; i++) {
      const toggle = mcpToggles.nth(i);
      if ((await toggle.getAttribute('aria-checked')) === 'true') await toggle.click();
    }
    await expect(approve).toBeEnabled();
    await approve.click();

    // SDK completes the PKCE exchange; the main tab becomes authenticated.
    await this.page.locator(this.selectors.authenticated).waitFor();
  }

  async loadModels(): Promise<void> {
    await this.page.locator(this.selectors.refreshModels).click();
    await expect(this.page.locator(this.selectors.modelSelector)).toBeEnabled();
  }

  async selectModel(modelId: string): Promise<void> {
    const trigger = this.page.locator(this.selectors.modelSelector);
    await expect(trigger).toBeEnabled();
    await trigger.click();
    await this.page.locator(this.selectors.modelSearchInput).fill(modelId);
    await this.page.getByTestId(`model-option-${modelId}`).click();
    await expect(trigger).toContainText(modelId);
  }

  async send(prompt: string): Promise<void> {
    await this.page.locator(this.selectors.chatInput).fill(prompt);
    await this.page.locator(this.selectors.sendButton).click();
  }

  async waitForAssistantTurn(turn: number): Promise<void> {
    await this.page.locator(this.selectors.message(turn, 'assistant')).waitFor();
    await this.page.locator(this.selectors.chatProcessing).waitFor({ state: 'hidden' });
  }

  async getAssistantText(turn: number): Promise<string> {
    return (await this.page.locator(this.selectors.message(turn, 'assistant')).textContent()) ?? '';
  }
}
```
(Selectors are the exact ones the current app exposes — verified in `Header.tsx`, `StatusIndicator.tsx`, `ChatInput.tsx`, `ModelCombobox.tsx`, `ChatMessages.tsx`, `MessageBubble.tsx`.)

- [ ] **Step 2: Typecheck via build of e2e (tsc through playwright)**

Run:
```bash
npx tsc --noEmit -p e2e/tsconfig.json 2>/dev/null || npx playwright test --list >/dev/null
```
Expected: no type errors referencing `ExtChatPage`. (If there is no `e2e/tsconfig.json`, the `--list` form compiles specs and will surface type errors.)

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/pages/ExtChatPage.ts
git commit -m "test(ext): add ExtChatPage page object for real-OAuth extension e2e"
```

---

## Task 5: Port `chat.spec.ts` to the extension + drop `webServer`; run green locally

Goal: the existing chat parity test runs against the extension and passes locally (headed).

**Files:**
- Modify: `e2e/chat.spec.ts`
- Modify: `playwright.config.ts`

- [ ] **Step 1: Remove the dev `webServer` from `playwright.config.ts`**

Delete the `webServer` block (the extension is loaded from `dist/`, not served):
```ts
  webServer: {
    command: 'npm run dev',
    url: baseURL,
    reuseExistingServer: false,
  },
```
Keep everything else (esp. `globalSetup: './e2e/tests/global-setup.ts'`, `workers: 1`, the `chromium` project).

- [ ] **Step 2: Rewrite `e2e/chat.spec.ts` to drive the extension**

```ts
import { test, expect } from '@playwright/test';
import { getTestState, FULL_MODEL_ID } from './tests/global-setup';
import { launchExtension } from './tests/utils/extension-context';
import { ExtChatPage } from './tests/pages/ExtChatPage';

test('chat answers what day comes after monday with tuesday', async () => {
  const { bodhiServerUrl, username, password } = getTestState();
  const context = await launchExtension();
  try {
    const page = await context.newPage();
    const chat = new ExtChatPage(page);

    await chat.openApp(bodhiServerUrl);
    await chat.login(context, { username, password });
    await chat.loadModels();
    await chat.selectModel(FULL_MODEL_ID);
    await chat.send('what day comes after monday? answer in one word');
    await chat.waitForAssistantTurn(0);

    const reply = await chat.getAssistantText(0);
    expect(reply.toLowerCase()).toContain('tuesday');
  } finally {
    await context.close();
  }
});
```
(`getTestState`, `FULL_MODEL_ID` are already exported from `e2e/tests/global-setup.ts`; `FULL_MODEL_ID` = `oai/gpt-4.1-nano`.)

- [ ] **Step 3: Build the extension, then run the e2e headed locally**

Run:
```bash
npm run build
HEADLESS=false npm run test:e2e
```
Expected: `global-setup` starts the in-process Bodhi server (port 51135) and configures the API model; the test opens the extension, logs in for real (Keycloak popup), and asserts "tuesday". PASS = 1 passed.

Troubleshooting (resolve before moving on):
- "Invalid parameter: redirect_uri" in the popup → Task 3 not done for this `EXTENSION_ID`.
- Stuck at `clientReady`/`serverReady` → confirm `default-host` reaches the server; the server sends permissive CORS for the extension origin (mirror of `sdk-test-app` direct mode). If blocked, add `"http://localhost/*"` to `manifest.json` `host_permissions`, rebuild, retry.
- A second auth popup appears after approve and doesn't auto-close → capture and close it: after `approve.click()`, `const p2 = await context.waitForEvent('page', { timeout: 3000 }).catch(() => null); await p2?.close();` before waiting for `authenticated`.

- [ ] **Step 4: Commit**

```bash
git add e2e/chat.spec.ts playwright.config.ts
git commit -m "test(ext): run chat parity e2e against the loaded extension (real OAuth)"
```

---

## Task 6: Green GitHub Actions run (definition of done)

Goal: push and confirm the CI workflow (build + unit + e2e under xvfb) is **green** — the gate that closes Phase 1.

**Files:**
- Modify (if needed): `.github/workflows/ci.yml`

- [ ] **Step 1: Confirm CI ordering and inputs**

Read `.github/workflows/ci.yml`. Confirm: the `Build` step (`npm run build`) runs **before** the `E2E tests` step (it does), so `dist/` exists when Playwright loads the extension; the `E2E tests` step runs under `xvfb-run ... npm run ci:test:e2e` with `HEADLESS: 'false'` (it does); and the `VITE_BODHI_*` build vars + `BODHIAPP_*` e2e secrets are present in the job `env` (they are). No `webServer` is needed anymore. If any of these are missing, fix them; otherwise no change.

- [ ] **Step 2: Push the branch**

Run:
```bash
git push origin main
```
(If working on a feature branch, push that branch and open a PR so CI runs.)

- [ ] **Step 3: Watch the run to completion**

Run:
```bash
RUN_ID=$(gh run list --repo bodhiapps/bookmarks-chat --workflow ci.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN_ID" --repo bodhiapps/bookmarks-chat --exit-status --interval 15
```
Expected: the run completes green (Lint, Build, Typecheck, Unit tests, **E2E tests** all ✓).

- [ ] **Step 4: If red, fix and repeat**

Inspect the failing step's logs / uploaded Playwright artifacts; fix; commit; push; re-watch. Common CI-only issues: the extension fails to load headless on non-Linux runners (this repo's runner is `ubuntu-latest`, headed under xvfb — fine); flaky popup timing (raise the specific `waitFor` or handle the second popup as in Task 5 Step 3). **Phase 1 is done only when this run is green.**

---

## Self-review

**Spec coverage (vs `docs/prd/07` Phase 1 AC):**
- Load unpacked → toolbar opens tab → real OAuth → models load → chat reply streams → Tasks 1, 2, 5 (+ manual smoke in Task 1 Step 10).
- `npm run build` dist id == `EXTENSION_ID` → Task 1 Step 9.
- `chat.spec.ts` green locally AND in GitHub Actions → Tasks 5, 6.
- Real Keycloak form + access-request approval, no `launchWebAuthFlow` stub → Task 4 `login()`.
- Redirect URI registration (ops, blocking) → Task 3.
- Web→ext SDK swap, dev `defaultHost` kept → Task 2.
- CRXJS + manifest + fixed id + Vite config → Task 1.

**Placeholder scan:** The three `PASTE_*` tokens (manifest `key`, `EXTENSION_ID` ×1 file) are not vague TODOs — they are concrete values produced by Task 1 Step 2's exact commands and pasted in the same task. All code blocks are complete. No "add error handling"/"similar to" placeholders.

**Type/name consistency:** `EXTENSION_ID`, `launchExtension`, `APP_DIST` (extension-context.ts) are used consistently by `ExtChatPage.ts` and `chat.spec.ts`. `getTestState`/`FULL_MODEL_ID` are imported from the existing `e2e/tests/global-setup.ts` (confirmed exports). Selector strings match the app's actual `data-testid`s. `ExtUIClient`/`BodhiExtClient`/`BodhiProvider` props match `sdk-test-app/ext` usage.

**Known empirical resolution points (each has an in-task verify + fallback, not a guess):** CRXJS×Vite version (Task 1 Step 1), setup-modal asset bundling (Task 2 Step 5), direct-mode CORS to localhost (Task 5 Step 3), possible second auth popup (Task 5 Step 3).

---

## Out of scope (do NOT implement here)
PGlite/Dexie, offscreen document, bookmarks enumeration/ingestion, content fetch→markdown, `search_bookmarks` tool, `bookmarks`/`offscreen`/`alarms`/`<all_urls>` permissions, the companion `bodhi-browser-ext` in e2e. These belong to Phases 2–3 and will be planned in later iterations.
