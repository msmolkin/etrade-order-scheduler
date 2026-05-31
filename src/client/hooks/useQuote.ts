/**
 * Slice 5.1 useQuote hook.
 *
 * react-query wrapper around fetchQuote() with stale-time tuned to ET market
 * hours: 2s during 09:30-16:00 ET on weekdays, 30s outside. The server LRU
 * (Slice 2.3) coalesces identical concurrent requests and serves cached
 * quotes for ~1s, so this hook layers on top of that without hammering it.
 *
 * Returns null-shaped Quote when no symbol is supplied (key falls through),
 * so the caller can pass an empty string while the user is still typing.
 */
import { useQuery } from "@tanstack/react-query";
import { fetchQuote } from "../utils/api";

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
}

export const quoteQueryKey = (symbol: string) => ["quote", symbol] as const;

/**
 * Returns true when "now" is between 09:30 and 16:00 ET on a weekday.
 * Used to drive the staleTime: tight refresh during regular hours, lazy
 * elsewhere (after-hours quotes barely move; saves request volume).
 */
function isMarketHoursET(now: Date = new Date()): boolean {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  if (wd === "Sat" || wd === "Sun") return false;
  const hh = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const mm = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  const minutes = hh * 60 + mm;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

function isTradingHoursET(now: Date = new Date()): boolean {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  if (wd === "Sat" || wd === "Sun") return false;
  const hh = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  return hh >= 7 && hh < 20;
}

function normalizeQuote(symbol: string, raw: any): Quote | null {
  if (!raw) return null;
  const q = raw.All ?? raw;
  const bid = typeof q.bid === "number" ? q.bid : 0;
  const ask = typeof q.ask === "number" ? q.ask : 0;
  const lastTrade = typeof q.lastTrade === "number" ? q.lastTrade : 0;
  const lastNum = typeof q.last === "number" ? q.last : 0;
  const last = lastTrade || lastNum || (bid && ask ? (bid + ask) / 2 : bid || ask || 0);
  return { symbol, bid, ask, last };
}

/**
 * @param symbol Uppercase ticker. Pass an empty string to suspend the query.
 */
export function useQuote(symbol: string, fast = false) {
  const sym = symbol.trim().toUpperCase();
  const enabled = sym.length > 0;
  const stale = fast
    ? 2_000
    : isTradingHoursET()
      ? 2_000
      : 30_000;

  return useQuery<Quote | null>({
    queryKey: quoteQueryKey(sym),
    queryFn: async () => {
      const quotes = await fetchQuote([sym]);
      const raw = Array.isArray(quotes) ? quotes[0] : quotes;
      return normalizeQuote(sym, raw);
    },
    enabled,
    staleTime: stale,
    refetchInterval: enabled ? stale : false,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
  });
}
