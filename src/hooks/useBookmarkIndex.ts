import { useEffect, useRef } from 'react';
import { useBodhi } from '@bodhiapp/bodhi-js-react-ext';
import { flattenBookmarks } from '@/lib/bookmarks';
import { documentCount } from '@/db/pglite';
import { indexPending } from '@/services/indexer';
import { syncBookmarks } from '@/services/sync';

const NS = 'default';

declare global {
  interface Window {
    __bookmarksIndex?: { count: number; syncedAt: number; error?: string };
  }
}

async function runOnce(): Promise<void> {
  const tree = await chrome.bookmarks.getTree();
  const nodes = flattenBookmarks(tree as unknown as Parameters<typeof flattenBookmarks>[0]);
  await syncBookmarks(NS, nodes);
  await indexPending(NS);
  const count = await documentCount(NS);
  window.__bookmarksIndex = { count, syncedAt: Date.now() };
}

export function useBookmarkIndex(): void {
  const { isAuthenticated } = useBodhi();
  const runningRef = useRef(false);

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;

    const trigger = async (): Promise<void> => {
      if (runningRef.current) return;
      runningRef.current = true;
      try {
        await runOnce();
      } catch (e) {
        if (!cancelled) {
          window.__bookmarksIndex = {
            count: window.__bookmarksIndex?.count ?? 0,
            syncedAt: Date.now(),
            error: (e as Error)?.message ?? String(e),
          };
        }
      } finally {
        runningRef.current = false;
      }
    };

    void trigger();

    const refresh = (): void => {
      void trigger();
    };
    chrome.bookmarks.onCreated.addListener(refresh);
    chrome.bookmarks.onChanged.addListener(refresh);
    chrome.bookmarks.onRemoved.addListener(refresh);
    chrome.bookmarks.onMoved.addListener(refresh);

    return () => {
      cancelled = true;
      chrome.bookmarks.onCreated.removeListener(refresh);
      chrome.bookmarks.onChanged.removeListener(refresh);
      chrome.bookmarks.onRemoved.removeListener(refresh);
      chrome.bookmarks.onMoved.removeListener(refresh);
    };
  }, [isAuthenticated]);
}
