import { BodhiExtClient } from '@bodhiapp/bodhi-js-react-ext';
import { AUTH_CLIENT_ID, AUTH_SERVER_URL } from './env';

const client = new BodhiExtClient(AUTH_CLIENT_ID, { authServerUrl: AUTH_SERVER_URL });
client
  .init()
  .catch((e: unknown) => console.error('[bg] BodhiExtClient init failed:', (e as Error).message));

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
});

chrome.runtime.onInstalled.addListener(() => console.log('[bg] installed'));
