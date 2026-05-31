import React from 'react';
import ReactDOM from 'react-dom/client';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import App from './App';
import { queryClient } from './utils/queryClient';
import { WSProvider } from './hooks/WSProvider';
import './styles/tokens.css';
import './index.css';

/**
 * Slice 3 cache root.
 *
 * PersistQueryClientProvider hydrates the QueryClient synchronously from
 * localStorage BEFORE the first render, so when the user re-opens the app
 * they see yesterday's orders / accounts / auth state immediately while the
 * background refetch runs. Brief §0 ("never make the user wait") is the
 * raison d'être of this slice; this is the line that makes good on it.
 *
 * WSProvider sits inside so order_update / auth_status pushes patch the
 * same QueryClient via setQueryData (Slice 3.2).
 */
const persister = createSyncStoragePersister({
  storage: window.localStorage,
  // Bump when we make breaking shape changes to cached data so old payloads
  // are silently dropped instead of fighting the new code.
  key: 'tp-rq-cache-v1',
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        // 24h: anything older than this is cold, refetch from the network.
        maxAge: 24 * 60 * 60_000,
        // Buster so a deploy can invalidate persisted caches on demand.
        buster: 'slice3-v1',
      }}
    >
      <WSProvider>
        <App />
      </WSProvider>
    </PersistQueryClientProvider>
  </React.StrictMode>
);
