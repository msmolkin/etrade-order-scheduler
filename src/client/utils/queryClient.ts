/**
 * Slice 3 client cache foundation.
 *
 * One QueryClient for the whole app. Defaults are tuned for "show stale data
 * instantly, refetch in the background, never block the user":
 *
 *   - orders / scoped lists:   staleTime  30s   (refetched on tab focus)
 *   - accounts / auth status:  staleTime  5min  (rarely change in a session)
 *   - everything:              gcTime    60min  (kept warm for the next visit)
 *
 * The persister in main.tsx hydrates this client from localStorage BEFORE the
 * first render so the user sees yesterday's orders immediately; live data
 * arrives via WS push (Slice 3.2) and refetch-on-focus.
 */
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 30s default; per-query overrides below for slower-moving data.
      staleTime: 30_000,
      gcTime: 60 * 60_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: 1,
    },
  },
});

/** Per-query stale-time presets so individual hooks don't drift. */
export const STALE = {
  orders: 30_000,
  deletedOrders: 60_000,
  expiredOrders: 60_000,
  accounts: 5 * 60_000,
  positions: 30_000,
  authStatus: 5 * 60_000,
} as const;

/**
 * Merge a single updated row into a cached array by id, preserving order.
 * Pushes to the front when not present (matches OrderList's previous WS
 * handler).
 */
export function mergeById<T extends { id: string }>(rows: T[] | undefined, updated: T): T[] {
  const list = rows ?? [];
  const idx = list.findIndex((r) => r.id === updated.id);
  if (idx === -1) return [updated, ...list];
  const copy = list.slice();
  copy[idx] = updated;
  return copy;
}

/** Remove a row by id from a cached array. */
export function removeById<T extends { id: string }>(rows: T[] | undefined, id: string): T[] {
  return (rows ?? []).filter((r) => r.id !== id);
}
