# 02 — Auth migration (web → extension Bodhi SDK)

Migrate from the **web** Bodhi React SDK to the **extension** flavor. The chat/agent/model code
is unchanged; only the client construction and a background service worker are new.

## Package swap

| Current (web)                              | New (extension)                                        |
| ------------------------------------------ | ------------------------------------------------------ |
| `@bodhiapp/bodhi-js-react`                 | `@bodhiapp/bodhi-js-react-ext`                         |
| `WebUIClient` (implicit)                   | `ExtUIClient` (UI) + `BodhiExtClient` (SW)             |
| `localStorage` tokens                      | `chrome.storage.session` tokens                        |
| redirect `http://localhost:45173/callback` | redirect `https://<fixed-id>.chromiumapp.org/callback` |

```bash
npm rm @bodhiapp/bodhi-js-react
npm i @bodhiapp/bodhi-js-react-ext
```

Reference: `bodhi-browser/sdk-test-app/ext/src/App.tsx` (UI) and
`bodhi-browser/sdk-test-app/ext/src-ext/background.ts` (SW), plus the SDK at
`bodhi-browser/bodhi-js-sdk/{ext,react-ext}`.

## UI side — `src/App.tsx`

Replace the `BodhiProvider` from the web package with the ext package, constructing an
`ExtUIClient` explicitly and passing it as `client`:

```tsx
import { BodhiProvider, ExtUIClient } from '@bodhiapp/bodhi-js-react-ext';
import { AUTH_CLIENT_ID, AUTH_SERVER_URL } from './env';

function App() {
  const client = useMemo(
    () =>
      new ExtUIClient(AUTH_CLIENT_ID, {
        authServerUrl: AUTH_SERVER_URL, // e.g. https://main-id.getbodhi.app/realms/bodhi
        logLevel: 'warn',
      }),
    []
  );
  return (
    <BodhiProvider
      client={client}
      defaultHost={import.meta.env.DEV ? 'http://localhost:55311' : undefined}
    >
      <AppContent />
    </BodhiProvider>
  );
}
```

- `useBodhi`, `useAgent`, model loading, the chat components, and MCP plumbing remain as-is.
- Keep the dev `defaultHost` trick (dead port) so a developer's local Bodhi App on the default
  port is not auto-probed — same intent as the prior web-app `defaultHost` change.
- `ExtUIClient` is a **facade**: it talks to the companion `bodhi-browser-ext` via
  `chrome.runtime` when present, else falls back to `DirectExtClient` (direct HTTP to a local
  Bodhi server). Both modes use the same real OAuth below.

## Background side — `src/background.ts`

```ts
import { BodhiExtClient } from '@bodhiapp/bodhi-js-react-ext';
import { AUTH_CLIENT_ID, AUTH_SERVER_URL } from './env';

const client = new BodhiExtClient(AUTH_CLIENT_ID, { authServerUrl: AUTH_SERVER_URL });
client.init().catch((e) => console.error('[bg] BodhiExtClient init failed', e));

chrome.runtime.onInstalled.addListener(() => {
  /* ensure offscreen + schedule ingestion alarm on first install (see 04) */
});
```

The SW client owns the OAuth + companion-discovery responsibilities; the UI client consumes
auth state. (`init()` wires `chrome.runtime` listeners and discovers the companion ext.)

## Real OAuth flow (what happens at login)

1. User clicks login in the UI → SDK creates an **access request** against the Bodhi server and
   opens a review tab/window; for the popup flow it then calls
   `chrome.identity.launchWebAuthFlow({ url: <authorize URL>, interactive: true })`.
2. `redirect_uri = chrome.identity.getRedirectURL('callback')` →
   `https://<fixed-extension-id>.chromiumapp.org/callback`. **PKCE** (`code_challenge`/`S256`),
   `state`, `code_verifier` stored in `chrome.storage.session`.
3. The auth window shows the **real Keycloak** login (`#username`, `#password`, `#kc-login`),
   then the **access-request review** page (`[data-testid="review-approve-button"]`).
4. On redirect back to `chromiumapp.org/callback`, Chrome returns the URL to the SDK, which
   exchanges `code`→tokens and stores them in `chrome.storage.session`.

This is exactly the flow automated in e2e — see `06` and
`bodhi-browser/sdk-test-app/e2e/tests/pages/AuthSection.ts` (`loginWithAccessRequest`).

## Token storage

`chrome.storage.session` (default `ChromeSessionStorageAdapter`): not persisted to disk,
cleared on browser close / extension reload. Acceptable for v1. The agent's `streamFn` injects
the Bodhi access token as `Authorization: Bearer` + `x-api-key` exactly as today
(`src/hooks/useAgent.ts`); no change needed there.

## Environment & client config — `src/env.ts`

Keep build-time validation. Vars (provided via CRXJS `define`/`import.meta.env`, see `03`):

| Var                          | Example                                     | Notes                      |
| ---------------------------- | ------------------------------------------- | -------------------------- |
| `VITE_BODHI_APP_CLIENT_ID`   | `bodhi-app-f181a4d1-…`                      | Reuse existing app client. |
| `VITE_BODHI_AUTH_SERVER_URL` | `https://main-id.getbodhi.app/realms/bodhi` | Same as today.             |

> **Ops prerequisite (blocking for login):** register
> `https://<fixed-extension-id>.chromiumapp.org/callback` as a valid redirect URI for
> `VITE_BODHI_APP_CLIENT_ID` (the same kind of external registration done earlier for
> `http://localhost:45173/callback`). The fixed ID comes from the manifest `key` (see `03`).
> Without this, Keycloak returns "Invalid parameter: redirect_uri".

## Acceptance criteria
- Loading the unpacked extension and clicking login completes real OAuth and lands in an
  authenticated state (`useBodhi().isAuthenticated === true`); models load and a chat reply
  streams (parity with today's `chat.spec.ts`).
- Tokens are present in `chrome.storage.session`; reloading the tab keeps the session until
  browser close.
