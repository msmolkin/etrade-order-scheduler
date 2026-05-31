/**
 * Hand-rolled LRU + request-coalesce cache for E*TRADE single-symbol quotes.
 *
 * - During ET market hours (Mon-Fri 9:30 AM - 4:00 PM, America/New_York):
 *   TTL = 2_000 ms.
 * - Outside market hours:
 *   TTL = 30_000 ms.
 *
 * Request coalescing: if a fetch is already in flight for a symbol, additional
 * callers await the same promise. On resolve, the resolved quote is cached with
 * a fresh expiresAt; on reject, the inflight slot is cleared so the next caller
 * re-fetches rather than memoising the failure.
 *
 * No npm deps. The Map is bounded only by the symbol universe the user trades,
 * which is tiny (tens, not thousands), so explicit eviction is unnecessary; we
 * just let stale entries age out via the TTL.
 */

interface CacheEntry {
  quote: unknown;
  expiresAt: number;
  inflight?: Promise<unknown>;
}

class QuoteCache {
  private store = new Map<string, CacheEntry>();

  /**
   * TTL for quote entries. 2 s during regular ET market hours, 30 s otherwise.
   * Determined per-call so DST and weekend transitions are handled automatically.
   */
  ttlMs(now: Date = new Date()): number {
    // Render the moment in ET to read its weekday + clock without TZ math.
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
    const hourStr = parts.find((p) => p.type === "hour")?.value ?? "00";
    const minuteStr = parts.find((p) => p.type === "minute")?.value ?? "00";
    const hour = parseInt(hourStr, 10);
    const minute = parseInt(minuteStr, 10);
    const minutes = hour * 60 + minute;

    const isWeekday = weekday !== "Sat" && weekday !== "Sun";
    const openMins = 9 * 60 + 30; // 09:30
    const closeMins = 16 * 60; // 16:00
    const inSession = isWeekday && minutes >= openMins && minutes < closeMins;
    return inSession ? 2_000 : 30_000;
  }

  /**
   * Get a cached quote or fetch + cache one. Coalesces concurrent fetches for
   * the same symbol onto a single in-flight promise.
   */
  async getQuote(
    symbol: string,
    fetcher: () => Promise<unknown>,
  ): Promise<unknown> {
    const key = symbol.toUpperCase();
    const now = Date.now();
    const existing = this.store.get(key);

    if (existing && existing.expiresAt > now && !existing.inflight) {
      return existing.quote;
    }

    if (existing?.inflight) {
      return existing.inflight;
    }

    const inflight = (async () => {
      const result = await fetcher();
      this.store.set(key, {
        quote: result,
        expiresAt: Date.now() + this.ttlMs(),
      });
      return result;
    })();

    // Reserve the slot so concurrent callers join the same promise. Preserve
    // any prior cached quote so a still-warm value survives a refresh attempt.
    this.store.set(key, {
      quote: existing?.quote,
      expiresAt: existing?.expiresAt ?? 0,
      inflight,
    });

    try {
      return await inflight;
    } catch (err) {
      // Drop the inflight slot on failure so the next caller retries instead
      // of awaiting an already-rejected promise.
      const current = this.store.get(key);
      if (current?.inflight === inflight) {
        if (existing && existing.expiresAt > Date.now()) {
          this.store.set(key, { quote: existing.quote, expiresAt: existing.expiresAt });
        } else {
          this.store.delete(key);
        }
      }
      throw err;
    }
  }

  /** Test/admin: drop all cached quotes. */
  clear(): void {
    this.store.clear();
  }
}

export const quoteCache = new QuoteCache();
