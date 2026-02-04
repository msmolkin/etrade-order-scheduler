/**
 * Shared broadcast for order updates. Set from index.ts (which has the WebSocket server);
 * routes call broadcastOrderUpdate(order) so clients (e.g. OrderList) can refetch.
 */
let broadcastFn: ((order: unknown) => void) | null = null;

export function setBroadcast(fn: (order: unknown) => void): void {
  broadcastFn = fn;
}

export function broadcastOrderUpdate(order: unknown): void {
  if (broadcastFn) broadcastFn(order);
}
