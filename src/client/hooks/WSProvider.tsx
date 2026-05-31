/**
 * Slice 3.2 single shared WebSocket.
 *
 * Replaces N per-component sockets (OrderList had its own; SystemStatusBar
 * is about to need one) with one connection owned for the lifetime of the
 * app. Subscribers register by event type and get typed callbacks.
 *
 * Reliability features added vs. the legacy useWebSocket:
 *   - Exponential backoff reconnect: 250ms → 4s, capped, with ±30% jitter.
 *   - 15s heartbeat ping; reconnect if no pong within 20s.
 *   - lastPongAt exposed via context so SystemStatusBar / Slice 6 widgets
 *     can render "heartbeat 4s ago".
 *   - On `order_update`: patches QueryClient (['orders'] / ['orders-deleted'])
 *     in place via setQueryData. No refetch. The Brief §1 promise.
 *   - On `auth_status`: writes to ['auth-status'] cache and invalidates
 *     ['auth-test'] so the next render reflects the new state.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Order, AuthStatus } from "../utils/api";
import { mergeById, removeById } from "../utils/queryClient";
import { ordersQueryKey } from "./useOrders";
import { deletedOrdersQueryKey } from "./useDeletedOrders";
import { authStatusQueryKey, authTestQueryKey } from "./useAuthStatus";

export interface WSMessage {
  type: string;
  [key: string]: unknown;
}

interface WSContextValue {
  isConnected: boolean;
  lastMessage: WSMessage | null;
  lastPongAt: number | null;
  subscribe: <T extends WSMessage = WSMessage>(
    type: string,
    handler: (msg: T) => void,
  ) => () => void;
  send: (msg: unknown) => void;
}

const WSContext = createContext<WSContextValue | null>(null);

const HEARTBEAT_INTERVAL_MS = 15_000;
const PONG_TIMEOUT_MS = 20_000;
const BACKOFF_MIN_MS = 250;
const BACKOFF_MAX_MS = 4_000;

function jittered(delay: number): number {
  return Math.round(delay * (1 + Math.random() * 0.3));
}

interface OrderUpdateMessage extends WSMessage {
  type: "order_update";
  order: Order;
}

interface AuthStatusMessage extends WSMessage {
  type: "auth_status";
  authenticated: boolean;
  sandbox: boolean;
  source: "auto" | "renew" | "expired";
}

interface PongMessage extends WSMessage {
  type: "pong";
}

export function WSProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [isConnected, setIsConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<WSMessage | null>(null);
  const [lastPongAt, setLastPongAt] = useState<number | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pongTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffRef = useRef<number>(BACKOFF_MIN_MS);
  const closedByCleanupRef = useRef<boolean>(false);
  const handlersRef = useRef<Map<string, Set<(msg: WSMessage) => void>>>(new Map());

  const dispatch = useCallback((msg: WSMessage) => {
    setLastMessage(msg);
    const set = handlersRef.current.get(msg.type);
    if (set) {
      for (const h of set) {
        try {
          h(msg);
        } catch (err) {
          console.error(`[ws] handler for ${msg.type} threw`, err);
        }
      }
    }
  }, []);

  const clearTimers = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
    if (pongTimerRef.current) {
      clearTimeout(pongTimerRef.current);
      pongTimerRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    closedByCleanupRef.current = false;
    const url = `ws://${window.location.host}/ws`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.error("[ws] constructor threw", err);
      scheduleReconnect();
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      backoffRef.current = BACKOFF_MIN_MS;
      // Start heartbeat.
      if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(JSON.stringify({ type: "ping" }));
        } catch (err) {
          console.error("[ws] ping send failed", err);
        }
        // Arm pong timeout.
        if (pongTimerRef.current) clearTimeout(pongTimerRef.current);
        pongTimerRef.current = setTimeout(() => {
          console.warn("[ws] pong timeout, force-reconnecting");
          try {
            ws.close(4000, "pong-timeout");
          } catch {
            /* ignore */
          }
        }, PONG_TIMEOUT_MS);
      }, HEARTBEAT_INTERVAL_MS);
    };

    ws.onclose = () => {
      setIsConnected(false);
      clearTimers();
      wsRef.current = null;
      if (closedByCleanupRef.current) return;
      scheduleReconnect();
    };

    ws.onerror = (event) => {
      // Don't treat this as fatal; onclose will follow.
      console.warn("[ws] error", event);
    };

    ws.onmessage = (event) => {
      let msg: WSMessage;
      try {
        msg = JSON.parse(event.data) as WSMessage;
      } catch (err) {
        console.error("[ws] non-JSON frame", err);
        return;
      }
      // Heartbeat: clear pong watchdog regardless of who emits the frame.
      if ((msg as PongMessage).type === "pong") {
        if (pongTimerRef.current) {
          clearTimeout(pongTimerRef.current);
          pongTimerRef.current = null;
        }
        setLastPongAt(Date.now());
        return; // No subscribers care about pongs themselves.
      }
      // Patch the QueryClient cache so consumers re-render via react-query.
      try {
        if (msg.type === "order_update") {
          const order = (msg as OrderUpdateMessage).order;
          if (order && typeof order.id === "string") {
            if (order.status === "DELETED") {
              qc.setQueryData<Order[]>(ordersQueryKey(), (rows) =>
                removeById(rows, order.id),
              );
              qc.setQueryData<Order[]>(deletedOrdersQueryKey(), (rows) =>
                mergeById(rows, order),
              );
            } else {
              qc.setQueryData<Order[]>(ordersQueryKey(), (rows) =>
                mergeById(rows, order),
              );
              qc.setQueryData<Order[]>(deletedOrdersQueryKey(), (rows) =>
                removeById(rows, order.id),
              );
            }
          }
        } else if (msg.type === "auth_status") {
          const evt = msg as AuthStatusMessage;
          qc.setQueryData<AuthStatus>(authStatusQueryKey(), (prev) => ({
            // Preserve consumerKeySet from the last GET; the WS event doesn't
            // carry it because it never changes within a session.
            consumerKeySet: prev?.consumerKeySet ?? true,
            authenticated: evt.authenticated,
            sandbox: evt.sandbox,
          }));
          // The companion /auth/test result is now stale; let it refetch.
          qc.invalidateQueries({ queryKey: authTestQueryKey() });
        }
      } catch (err) {
        console.error("[ws] cache patch failed", err);
      }
      dispatch(msg);
    };
  }, [clearTimers, dispatch, qc]);

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) return;
    const delay = jittered(backoffRef.current);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      backoffRef.current = Math.min(backoffRef.current * 2, BACKOFF_MAX_MS);
      connect();
    }, delay);
  }, [connect]);

  // Mount/unmount.
  useEffect(() => {
    connect();
    return () => {
      closedByCleanupRef.current = true;
      clearTimers();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    };
    // connect/clearTimers are stable (their deps are stable). Run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const subscribe = useCallback<WSContextValue["subscribe"]>((type, handler) => {
    let set = handlersRef.current.get(type);
    if (!set) {
      set = new Set();
      handlersRef.current.set(type, set);
    }
    set.add(handler as (msg: WSMessage) => void);
    return () => {
      const s = handlersRef.current.get(type);
      if (!s) return;
      s.delete(handler as (msg: WSMessage) => void);
      if (s.size === 0) handlersRef.current.delete(type);
    };
  }, []);

  const send = useCallback((msg: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(msg));
      } catch (err) {
        console.error("[ws] send failed", err);
      }
    }
  }, []);

  const value = useMemo<WSContextValue>(
    () => ({ isConnected, lastMessage, lastPongAt, subscribe, send }),
    [isConnected, lastMessage, lastPongAt, subscribe, send],
  );

  return <WSContext.Provider value={value}>{children}</WSContext.Provider>;
}

/** Internal: throws if called outside a WSProvider. Most callers should use
 * the safer useWS() / useWSEvent() helpers below. */
function useWSContext(): WSContextValue {
  const ctx = useContext(WSContext);
  if (!ctx) {
    throw new Error("useWS must be used within <WSProvider>");
  }
  return ctx;
}

export function useWS(): WSContextValue {
  return useWSContext();
}

/**
 * Subscribe a typed handler to a specific event. Auto-unsubscribes on unmount
 * or when `type` changes. The handler reference can change across renders
 * without re-subscribing — we read it from a ref.
 */
export function useWSEvent<T extends WSMessage = WSMessage>(
  type: string,
  handler: (msg: T) => void,
): void {
  const ctx = useWSContext();
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  useEffect(() => {
    return ctx.subscribe<T>(type, (msg) => handlerRef.current(msg));
  }, [ctx, type]);
}
