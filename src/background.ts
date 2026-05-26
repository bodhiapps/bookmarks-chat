import { BodhiExtClient } from '@bodhiapp/bodhi-js-react-ext';
import { AUTH_CLIENT_ID, AUTH_SERVER_URL } from './env';

const client = new BodhiExtClient(AUTH_CLIENT_ID, { authServerUrl: AUTH_SERVER_URL });
client.init().catch((e: unknown) => {
  console.error('[bg] BodhiExtClient init failed:', (e as Error).message);
});

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

chrome.runtime.onInstalled.addListener(() => {
  console.log('[bg] installed');
  void ensureOffscreen();
});
