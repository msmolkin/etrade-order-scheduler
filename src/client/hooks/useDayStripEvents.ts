/**
 * Slice 4.1 day-strip event derivation.
 *
 * Derives a typed `DayStripEvent[]` for today's timeline from the cached
 * orders list + auth heartbeat heuristic. Stays pure-client: no extra
 * network. Heartbeat outcomes are best-effort until Slice 6 wires the
 * real scheduler heartbeat row.
 *
 * Bucket layout (always emitted, regardless of order data):
 *   - 03:00 morning auth                (one dot)
 *   - 04:00, 05:00, 06:00, 06:55,
 *     07:00, 08:00 ... 19:00 heartbeats (one dot per slot)
 *   - 07:00 EXTENDED fire               (count overlay = fills/total)
 *   - 09:30 MARKET fire                 (count overlay)
 *   - 16:00 close marker                (one dot)
 *   - 22:30 DB dump                     (one dot)
 *
 * "Imminent" = within 30 min ahead of `now`. The DayStrip component
 * applies the amber pulse keyframe when `outcome === 'amber'`; we set
 * outcome to 'amber' for the upcoming fire windows so they pulse, and
 * keep the underlying ok/bad outcome for past fires.
 */
import { useMemo } from "react";
import { useOrders } from "./useOrders";
import { useAuthStatus } from "./useAuthStatus";
import { useHealth } from "./useHealth";
import type { Order } from "../utils/api";

export type DayStripEventLabel =
  | "auth"
  | "heartbeat"
  | "extended-fire"
  | "market-fire"
  | "close"
  | "dump";

export type DayStripEventOutcome = "ok" | "amber" | "bad" | "pending";

export interface DayStripEvent {
  id: string;
  /** ISO timestamp anchored to today in ET. */
  at: string;
  label: DayStripEventLabel;
  outcome: DayStripEventOutcome;
  /** For fire events: how many of the lineage filled vs total scheduled. */
  count?: { done: number; total: number };
}

/** Strip start / end in ET hours. The DayStrip renders this same window. */
const STRIP_START_HOUR = 3;
const STRIP_END_HOUR = 22.5; // 22:30

const IMMINENT_MS = 30 * 60_000;

const etPartFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Build a Date for today at a given hour:minute in America/New_York.
 *
 * Approach: ask Intl what the wall-clock components of `now` are in ET,
 * then use Date.UTC + the offset implied by the difference between the
 * ET wall clock and UTC. This is timezone-correct and DST-safe without
 * pulling a date-fns-tz dep.
 */
function todayAtET(hour: number, minute: number): Date {
  const now = new Date();
  const parts = etPartFormatter.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const y = parseInt(get("year"), 10);
  const m = parseInt(get("month"), 10) - 1;
  const d = parseInt(get("day"), 10);

  // Offset = (UTC wall) - (ET wall); we use it to map (y/m/d hour:minute ET)
  // to a real instant.
  const etWall = Date.UTC(
    y,
    m,
    d,
    parseInt(get("hour"), 10),
    parseInt(get("minute"), 10),
    parseInt(get("second"), 10),
  );
  const offsetMs = etWall - now.getTime();
  // hour can be fractional (we don't use that path, but be safe).
  const targetEtWall = Date.UTC(y, m, d, hour, minute, 0);
  return new Date(targetEtWall - offsetMs);
}

/** Today YYYY-MM-DD in ET. Used to filter fires to "today only". */
function todayKeyET(): string {
  return dayKeyFormatter.format(new Date());
}

/** Day of the week the strip is tracking, in ET. Used to scope orders. */
function dayKeyForDateET(d: Date): string {
  return dayKeyFormatter.format(d);
}

interface FireBucket {
  total: number;
  done: number;
  anyReject: boolean;
  pendingOnly: boolean;
}

function emptyBucket(): FireBucket {
  return { total: 0, done: 0, anyReject: false, pendingOnly: true };
}

function classify(order: Order): "filled" | "rejected" | "pending" {
  if (order.status === "FILLED" || order.status === "PARTIALLY_FILLED")
    return "filled";
  if (order.lastError || order.status === "REJECTED") return "rejected";
  return "pending";
}

function bucketOutcome(
  b: FireBucket,
  fireAt: Date,
  now: Date,
): DayStripEventOutcome {
  if (b.total === 0) {
    // No orders scheduled at this slot. Past = ok (nothing to do); future =
    // pending; imminent (within 30m ahead) = amber.
    if (fireAt.getTime() < now.getTime()) return "ok";
    if (fireAt.getTime() - now.getTime() < IMMINENT_MS) return "amber";
    return "pending";
  }
  if (b.anyReject) return "bad";
  if (
    fireAt.getTime() - now.getTime() < IMMINENT_MS &&
    fireAt.getTime() > now.getTime()
  ) {
    return "amber";
  }
  if (b.pendingOnly) {
    // Future fire; not yet at the wire.
    return fireAt.getTime() < now.getTime() ? "ok" : "pending";
  }
  return "ok";
}

/**
 * Pull fills + rejects + pendings for an EXTENDED (07:00) or MARKET (09:30)
 * fire window today. We bucket by the order's scheduledFor calendar day in
 * ET and its sessionTime; fills can also be matched via filledAt for orders
 * that already ran.
 */
function collectFireBucket(
  orders: Order[],
  session: "EXTENDED" | "MARKET",
  fireAt: Date,
): FireBucket {
  const todayKey = dayKeyForDateET(fireAt);
  const bucket = emptyBucket();
  for (const o of orders) {
    if (o.sessionTime !== session) continue;
    const sched = o.scheduledFor ? new Date(o.scheduledFor) : null;
    const filled = o.filledAt ? new Date(o.filledAt) : null;
    const matchesScheduled = sched && dayKeyForDateET(sched) === todayKey;
    const matchesFilled = filled && dayKeyForDateET(filled) === todayKey;
    if (!matchesScheduled && !matchesFilled) continue;

    bucket.total += 1;
    const k = classify(o);
    if (k === "filled") {
      bucket.done += 1;
      bucket.pendingOnly = false;
    } else if (k === "rejected") {
      bucket.anyReject = true;
      bucket.pendingOnly = false;
    }
  }
  return bucket;
}

/**
 * Heartbeat outcome.
 *
 * Slice 6.2 wires this to /api/health.lastHeartbeatAt — if a slot's
 * scheduled time is in the past and the most recent heartbeat ts on the
 * server is older than that slot (or null), the slot is colored 'bad'
 * (the scheduler missed it). Otherwise the previous behavior:
 *   - past slot: 'ok' if auth currently looks healthy, else 'pending'.
 *   - imminent slot (within 30 min): 'amber'.
 *   - future slot: 'pending'.
 */
function heartbeatOutcome(
  at: Date,
  now: Date,
  authHealthy: boolean,
  lastHeartbeatAt: Date | null,
): DayStripEventOutcome {
  const delta = at.getTime() - now.getTime();
  // If this slot already passed and the most recent server heartbeat is
  // older than the slot itself (or missing entirely), the scheduler missed
  // the slot — paint it red.
  if (delta < 0) {
    if (lastHeartbeatAt === null) return "bad";
    if (lastHeartbeatAt.getTime() < at.getTime()) return "bad";
  }
  if (delta < -IMMINENT_MS) {
    return authHealthy ? "ok" : "pending";
  }
  if (delta < 0) {
    return authHealthy ? "ok" : "amber";
  }
  if (delta < IMMINENT_MS) return "amber";
  return "pending";
}

function buildHeartbeatSlots(): Array<{ h: number; m: number }> {
  const slots: Array<{ h: number; m: number }> = [];
  // Pre-market hourly probes 04..06.
  for (let h = 4; h <= 6; h++) slots.push({ h, m: 0 });
  // 06:55 pre-EXTENDED probe.
  slots.push({ h: 6, m: 55 });
  // 07:00 (also a fire, but heartbeat carries the dot in the off-hours;
  // the fire dot is its own event).
  slots.push({ h: 7, m: 0 });
  // 08:00..19:00 hourly probes during market+post.
  for (let h = 8; h <= 19; h++) slots.push({ h, m: 0 });
  return slots;
}

/**
 * Compute the day-strip events. Memoized on orders + auth health so the
 * DayStrip only re-renders dots when something material changed.
 */
export function useDayStripEvents(): DayStripEvent[] {
  const { data: orders = [] } = useOrders();
  const auth = useAuthStatus();
  const { data: health } = useHealth();
  const authHealthy =
    auth.status?.authenticated === true &&
    (auth.testResult === null || auth.testResult.ok !== false);
  const lastHeartbeatAt = health?.lastHeartbeatAt
    ? new Date(health.lastHeartbeatAt)
    : null;

  return useMemo(() => {
    const now = new Date();
    const todayKey = todayKeyET();
    const events: DayStripEvent[] = [];

    // 03:00 morning auth.
    {
      const at = todayAtET(3, 0);
      events.push({
        id: `auth-${todayKey}`,
        at: at.toISOString(),
        label: "auth",
        outcome:
          at.getTime() < now.getTime()
            ? authHealthy
              ? "ok"
              : "bad"
            : at.getTime() - now.getTime() < IMMINENT_MS
              ? "amber"
              : "pending",
      });
    }

    // 04:00 ... 19:00 heartbeats.
    for (const slot of buildHeartbeatSlots()) {
      const at = todayAtET(slot.h, slot.m);
      events.push({
        id: `hb-${todayKey}-${slot.h}-${slot.m}`,
        at: at.toISOString(),
        label: "heartbeat",
        outcome: heartbeatOutcome(at, now, authHealthy, lastHeartbeatAt),
      });
    }

    // 07:00 EXTENDED fire window.
    {
      const at = todayAtET(7, 0);
      const bucket = collectFireBucket(orders, "EXTENDED", at);
      events.push({
        id: `fire-extended-${todayKey}`,
        at: at.toISOString(),
        label: "extended-fire",
        outcome: bucketOutcome(bucket, at, now),
        count:
          bucket.total > 0
            ? { done: bucket.done, total: bucket.total }
            : undefined,
      });
    }

    // 09:30 MARKET fire window.
    {
      const at = todayAtET(9, 30);
      const bucket = collectFireBucket(orders, "MARKET", at);
      events.push({
        id: `fire-market-${todayKey}`,
        at: at.toISOString(),
        label: "market-fire",
        outcome: bucketOutcome(bucket, at, now),
        count:
          bucket.total > 0
            ? { done: bucket.done, total: bucket.total }
            : undefined,
      });
    }

    // 16:00 close.
    {
      const at = todayAtET(16, 0);
      events.push({
        id: `close-${todayKey}`,
        at: at.toISOString(),
        label: "close",
        outcome:
          at.getTime() < now.getTime()
            ? "ok"
            : at.getTime() - now.getTime() < IMMINENT_MS
              ? "amber"
              : "pending",
      });
    }

    // 22:30 DB dump.
    {
      const at = todayAtET(22, 30);
      events.push({
        id: `dump-${todayKey}`,
        at: at.toISOString(),
        label: "dump",
        outcome:
          at.getTime() < now.getTime()
            ? "ok"
            : at.getTime() - now.getTime() < IMMINENT_MS
              ? "amber"
              : "pending",
      });
    }

    return events;
  }, [orders, authHealthy, lastHeartbeatAt]);
}

/**
 * Map an ISO timestamp to a percent (0..100) along the strip's
 * 03:00 -> 22:30 ET window. Exposed for DayStrip's render and the parent's
 * scrollToFire jump logic.
 */
export function timeToStripPct(iso: string): number {
  const target = new Date(iso).getTime();
  const start = todayAtET(STRIP_START_HOUR, 0).getTime();
  const end = todayAtET(
    Math.floor(STRIP_END_HOUR),
    (STRIP_END_HOUR % 1) * 60,
  ).getTime();
  if (end <= start) return 0;
  const pct = ((target - start) / (end - start)) * 100;
  return Math.max(0, Math.min(100, pct));
}

/** Today-anchored ET wall clock for the "NOW" line position (0..100 pct). */
export function nowStripPct(): number {
  const now = Date.now();
  const start = todayAtET(STRIP_START_HOUR, 0).getTime();
  const end = todayAtET(
    Math.floor(STRIP_END_HOUR),
    (STRIP_END_HOUR % 1) * 60,
  ).getTime();
  if (end <= start) return 0;
  const pct = ((now - start) / (end - start)) * 100;
  return Math.max(0, Math.min(100, pct));
}
