/**
 * Slice 3.2 compatibility shim.
 *
 * The legacy useWebSocket(url) created its own per-component socket. After
 * Slice 3.2 the app owns one shared socket via WSProvider. This hook
 * exposes the same {isConnected, lastMessage, sendMessage} surface so any
 * unmigrated callers (none in this repo today, but keep the door open) keep
 * working without spawning a second connection.
 *
 * The `url` argument is intentionally ignored; the shared provider always
 * targets `ws://${window.location.host}/ws`. New code should call
 * useWS()/useWSEvent() from ./WSProvider directly.
 */
import { useWS } from "./WSProvider";

export function useWebSocket(_url?: string) {
  const { isConnected, lastMessage, send } = useWS();
  return { isConnected, lastMessage, sendMessage: send };
}
