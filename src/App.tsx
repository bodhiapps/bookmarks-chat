import { useEffect, useMemo, useRef } from 'react';
import { BodhiProvider, useBodhi, BodhiBadge, ExtUIClient } from '@bodhiapp/bodhi-js-react-ext';
import { Toaster } from '@/components/ui/sonner';
import { AUTH_CLIENT_ID, AUTH_SERVER_URL } from './env';
import Layout from './components/Layout';
import type { Message } from './lib/messages';

function parseExtInitParams():
  | {
      extension?: {
        timeoutMs?: number;
        attempts?: number;
        attemptWaitMs?: number;
        attemptTimeout?: number;
      };
    }
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
  return import.meta.env.DEV ? 'http://localhost:55311' : undefined;
}

function AppContent() {
  const { clientState, showSetup, isAuthenticated } = useBodhi();
  const hasAutoOpenedRef = useRef(false);
  const hasTriggeredIngestRef = useRef(false);

  useEffect(() => {
    if (isAuthenticated && !hasTriggeredIngestRef.current) {
      hasTriggeredIngestRef.current = true;
      chrome.runtime
        .sendMessage({ type: 'ingest:trigger', payload: { reason: 'auth-ready' } } satisfies Message)
        .catch(() => {});
    }
  }, [isAuthenticated]);

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
    <BodhiProvider client={client} setupModal="setup-modal-v2" {...(defaultHost !== undefined ? { defaultHost } : {})}>
      <AppContent />
      <div className="fixed bottom-4 right-6 z-50">
        <BodhiBadge size="md" variant="light" />
      </div>
    </BodhiProvider>
  );
}

export default App;
