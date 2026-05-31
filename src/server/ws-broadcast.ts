/**
 * Shared broadcast helpers for server-to-client push events. The WS server in
 * index.ts wires the actual sender via setBroadcast(); routes/services then
 * call the typed helpers below so clients (e.g. OrderList, useAuthStatus) can
 * react.
 */
import { OrderService } from "./services/order-service.js";

let broadcastFn: ((payload: unknown) => void) | null = null;

export function setBroadcast(fn: (payload: unknown) => void): void {
  broadcastFn = fn;
}

export function broadcastOrderUpdate(order: unknown): void {
  if (broadcastFn) broadcastFn(order);
}

/**
 * Notify clients of an auth-state transition. `source` indicates how we
 * arrived at this state: 'auto' = completeAutoAuthSession just saved fresh
 * tokens; 'renew' = silent renewAccessToken success; 'expired' = a renewal
 * attempt was rejected (or skipped) and tokens are no longer usable.
 *
 * Slice 6.3: when this transitions to authenticated:true, we also requeue
 * any orders parked at PAUSED with the "queued for auth recovery" sentinel
 * (see OrderExecutor's auth-error path). For each requeued order we
 * broadcast an order_update so the client cache flips back to SCHEDULED
 * without a manual poll.
 */
export function broadcastAuthStatus(payload: {
  authenticated: boolean;
  sandbox: boolean;
  source: "auto" | "renew" | "expired";
}): void {
  if (broadcastFn) broadcastFn({ type: "auth_status", ...payload });
  if (payload.authenticated && (payload.source === "auto" || payload.source === "renew")) {
    // Fire-and-forget: don't block the auth code path. Failures are logged
    // but never bubble back to the OAuth/renew callers.
    void requeueAndBroadcast();
  }
}

async function requeueAndBroadcast(): Promise<void> {
  try {
    const svc = new OrderService();
    const ids = await svc.requeueAfterAuthRestore();
    if (ids.length === 0) return;
    console.log(
      `[auth-restore] requeued ${ids.length} order(s) after auth: ${ids.join(", ")}`,
    );
    for (const id of ids) {
      const order = await svc.getOrder(id);
      if (order && broadcastFn) {
        broadcastFn({ type: "order_update", order });
      }
    }
  } catch (err: any) {
    console.error("[auth-restore] requeueAfterAuthRestore failed:", err?.message ?? err);
  }
}
