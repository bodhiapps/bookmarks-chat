# 03 — Manifest, build (CRXJS), and fixed extension ID

## Build tool: `@crxjs/vite-plugin`

CRXJS turns the existing Vite app into an MV3 build (reads `manifest.json` as the entry,
bundles the SW/offscreen/HTML, gives HMR in dev, carries the `key` through to `dist/`).

```bash
npm i -D @crxjs/vite-plugin
```

`vite.config.ts` (extend the current one — keep `@` alias, Tailwind, React):

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';

export default defineConfig({
  plugins: [react(), tailwindcss(), crx({ manifest })],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  // PGlite ships WASM that esbuild pre-bundling breaks; emit workers as ES modules.
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  worker: { format: 'es' },
  server: { port: 45173, strictPort: true }, // dev only
});
```

> PGlite worker under CRXJS: instantiate via
> `new Worker(new URL('./pglite-worker.ts', import.meta.url), { type: 'module' })` (yt-chat
> pattern). Verify CRXJS emits the worker + `.wasm` into `dist/`; if a chunk is missing at
> runtime, add the worker/wasm to `web_accessible_resources`. This is a known integration
> wrinkle — validate early in Phase 2.

## Entry points (files to add)

| File                                            | Role                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `index.html` (exists)                           | Full-page tab UI; opened as a tab via `action.onClicked` (no `default_popup`). |
| `src/background.ts`                             | MV3 service worker (`background.service_worker`, `type: module`).              |
| `src/offscreen/offscreen.html` + `offscreen.ts` | Offscreen doc hosting PGlite + ingestion.                                      |

Open the UI as a **full-page tab** from the toolbar icon (not a popup):

```ts
// in background.ts
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
});
```

(omit `action.default_popup` so `onClicked` fires).

## `manifest.json`

```json
{
  "manifest_version": 3,
  "name": "Bookmarks Chat",
  "version": "0.1.0",
  "key": "<BASE64_DER_PUBLIC_KEY>",
  "action": { "default_title": "Open Bookmarks Chat" },
  "background": { "service_worker": "src/background.ts", "type": "module" },
  "permissions": ["identity", "storage", "bookmarks", "offscreen", "alarms"],
  "host_permissions": ["https://main-id.getbodhi.app/*", "<all_urls>"],
  "web_accessible_resources": [
    {
      "resources": ["assets/*", "src/offscreen/offscreen.html"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

Permission rationale:
- `identity` — `launchWebAuthFlow` OAuth.
- `storage` — tokens (`chrome.storage.session`) + ingestion cursor (`chrome.storage.local`).
- `bookmarks` — read bookmarks + change events.
- `offscreen` — create the offscreen document.
- `alarms` — resume gradual ingestion after SW suspension.
- `host_permissions: <all_urls>` — **required** to `fetch()` arbitrary bookmarked pages for
  content ingestion without CORS. This is a deliberately broad permission; document it in the
  store listing. (Auth host is listed explicitly for clarity.)
- Also confirm whether the SDK requires the companion-ext setup-modal HTML in
  `web_accessible_resources` (sdk-test-app lists `setup-modal*.html`); add if the SDK serves it.

## Fixed extension ID (deterministic)

A pinned ID is required so (a) the OAuth `chromiumapp.org` redirect URI is stable and (b) e2e
can navigate to `chrome-extension://<fixed-id>/index.html`.

Generate once and commit the **public** key into `manifest.key` (keep `key.pem` **out** of git):

```bash
# (a) private key (PKCS#8, unencrypted) — DO NOT COMMIT
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out key.pem
# (b) base64 DER public key → paste into manifest.json "key"
openssl rsa -in key.pem -pubout -outform DER | openssl base64 -A
# (c) the resulting extension ID (macOS uses shasum)
openssl rsa -in key.pem -pubout -outform DER | shasum -a 256 | head -c32 | tr 0-9a-f a-p
```

Commit a helper + constant so tests can hard-code the ID:

```ts
// e2e/tests/utils/extension-id.ts
import { createHash } from 'crypto';
export function extensionIdFromKey(b64: string): string {
  return createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex')
    .slice(0, 32).split('').map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join('');
}
export const EXTENSION_ID = '<computed-fixed-id>';
```

Then register `https://<EXTENSION_ID>.chromiumapp.org/callback` with the Bodhi app client
(see `02`, ops prerequisite).

> Security note: the RSA private key (`key.pem`) must be gitignored and stored as a CI secret if
> CI ever needs to repackage with the same key. Only the base64 **public** key goes in the
> committed `manifest.json`.

## Dev workflow
- `npm run dev` → CRXJS dev server with HMR; load `dist/` (or the CRXJS-served dir) via
  `chrome://extensions` → "Load unpacked".
- `npm run build` → `tsc -b && vite build` → `dist/` (the folder e2e and the store consume).
  Remember: the `typecheck` script is a no-op in this repo — rely on `build` for type checking.

## Acceptance criteria
- `npm run build` produces a loadable `dist/` whose computed ID equals `EXTENSION_ID`.
- Loading unpacked shows the toolbar icon; clicking it opens the full-page tab.
- The offscreen document can be created (`chrome.offscreen.hasDocument()` toggles true).
