import { BodhiExtClient } from '@bodhiapp/bodhi-js-react-ext';
import { AUTH_CLIENT_ID, AUTH_SERVER_URL } from './env';
import { flattenBookmarks } from './lib/bookmarks';
import type { Message } from './lib/messages';

const client = new BodhiExtClient(AUTH_CLIENT_ID, { authServerUrl: AUTH_SERVER_URL });
client.init().catch((e: unknown) => console.error('[bg] BodhiExtClient init failed:', (e as Error).message));

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
});

async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('src/offscreen/offscreen.html'),
      reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.DOM_PARSER],
      justification: 'Owns PGlite + Dexie for local bookmark indexing and search.',
    });
  } catch {
    // race: another caller created it concurrently — fine.
  }
}

let _ingestSeq = 0;
async function kickoffIngest(reason: string): Promise<void> {
  await ensureOffscreen();
  const tree = await chrome.bookmarks.getTree();
  const nodes = flattenBookmarks(tree as unknown as Parameters<typeof flattenBookmarks>[0]);
  _ingestSeq += 1;
  const msg: Message = { type: 'ingest:start', requestId: `bg-${_ingestSeq}`, payload: { reason, nodes } };
  await chrome.runtime.sendMessage(msg).catch((e) => console.warn('[bg] ingest:start failed', e));
}

chrome.runtime.onMessage.addListener((msg: Message) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'ingest:trigger') {
    void kickoffIngest(msg.payload.reason);
  } else if (msg.type === 'db:query' || msg.type === 'db:count') {
    void ensureOffscreen();
  }
});

const refresh = () => {
  void kickoffIngest('bookmark-change');
};
chrome.bookmarks.onCreated.addListener(refresh);
chrome.bookmarks.onChanged.addListener(refresh);
chrome.bookmarks.onRemoved.addListener(refresh);
chrome.bookmarks.onMoved.addListener(refresh);

chrome.alarms.create('ingest-poke', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'ingest-poke') void ensureOffscreen();
});

chrome.runtime.onInstalled.addListener(() => console.log('[bg] installed'));
chrome.runtime.onStartup.addListener(() => void ensureOffscreen());
