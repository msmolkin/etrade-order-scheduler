/**
 * Slice 4.1 DayStrip.
 *
 * Horizontal 56px-tall timeline above the order list. Spans 03:00 -> 22:30 ET.
 * Tick marks at 04:00, 07:00, 09:30, 12:00, 16:00, 20:00. A NOW line
 * animates left -> right every second. Event dots colored by outcome,
 * with imminent (next 30 min) dots pulsing amber.
 *
 * Click a dot -> calls `onJumpToFire(timeISO)` so the parent can scroll
 * the order list. The parent wires that scroll handler in Slice 4.4.
 *
 * Data is fed in via props (the parent calls `useDayStripEvents()`); this
 * component is rendering-only so it's easy to unit-test if we ever do.
 */
import { useEffect, useState } from "react";
import {
  type DayStripEvent,
  nowStripPct,
  timeToStripPct,
} from "../hooks/useDayStripEvents";

const etFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function formatEt(): string {
  return etFormatter.format(new Date());
}

interface DayStripProps {
  events: DayStripEvent[];
  onJumpToFire?: (atISO: string) => void;
}

interface Tick {
  label: string;
  hour: number;
  minute: number;
}

const TICKS: Tick[] = [
  { label: "04:00", hour: 4, minute: 0 },
  { label: "07:00", hour: 7, minute: 0 },
  { label: "09:30", hour: 9, minute: 30 },
  { label: "12:00", hour: 12, minute: 0 },
  { label: "16:00", hour: 16, minute: 0 },
  { label: "20:00", hour: 20, minute: 0 },
];

function tickPct(hour: number, minute: number): number {
  // The strip spans 03:00 -> 22:30 ET (19.5h). Using the wall-clock minute
  // count keeps the tick math DST-independent.
  const stripStartMin = 3 * 60;
  const stripEndMin = 22 * 60 + 30;
  const targetMin = hour * 60 + minute;
  const pct =
    ((targetMin - stripStartMin) / (stripEndMin - stripStartMin)) * 100;
  return Math.max(0, Math.min(100, pct));
}

function eventColor(outcome: DayStripEvent["outcome"]): string {
  switch (outcome) {
    case "ok":
      return "var(--ok)";
    case "bad":
      return "var(--bad)";
    case "amber":
      return "var(--accent)";
    case "pending":
    default:
      return "var(--paused)";
  }
}

function eventLabelText(label: DayStripEvent["label"]): string {
  switch (label) {
    case "auth":
      return "auth";
    case "heartbeat":
      return "hb";
    case "extended-fire":
      return "07 EXT";
    case "market-fire":
      return "09:30 MKT";
    case "close":
      return "close";
    case "dump":
      return "dump";
  }
}

function eventTitle(e: DayStripEvent): string {
  const t = new Date(e.at).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const base = `${t} ET - ${eventLabelText(e.label)} - ${e.outcome}`;
  if (e.count) return `${base} - ${e.count.done}/${e.count.total} filled`;
  return base;
}

export default function DayStrip({ events, onJumpToFire }: DayStripProps) {
  const [nowPct, setNowPct] = useState<number>(() => nowStripPct());
  const [etClock, setEtClock] = useState<string>(() => formatEt());
  const [open, setOpen] = useState(false);

  // 1Hz tick is enough; the line moves ~0.001%/sec at this resolution and
  // the user's eye won't notice sub-second jitter. requestAnimationFrame
  // would be wasteful for a strip that spans 19.5h.
  useEffect(() => {
    const id = setInterval(() => {
      setNowPct(nowStripPct());
      setEtClock(formatEt());
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      data-testid="day-strip"
      className="mono"
      style={{
        position: "relative",
        width: "100%",
        height: open ? 56 : "auto",
        background: "var(--bg-1)",
        borderBottom: "1px solid var(--bg-2)",
        padding: "6px 16px 0",
        boxSizing: "border-box",
      }}
    >
      {/* Header row: title left, NOW value right */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 10.5,
          letterSpacing: "0.04em",
          color: "var(--text-dim)",
          textTransform: "uppercase",
          marginBottom: 4,
        }}
      >
        <span
          role="button"
          tabIndex={0}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setOpen((v) => !v);
            }
          }}
          style={{ cursor: "pointer", userSelect: "none" }}
        >
          <span
            style={{
              display: "inline-block",
              marginRight: 4,
              fontSize: 8,
              transition: "transform 0.15s",
              transform: open ? "none" : "none",
            }}
          >
            {open ? "\u25BC" : "\u25B6"}
          </span>
          Today - America/New_York
        </span>
        <span>
          NOW <b style={{ color: "var(--text)" }}>{etClock} ET</b>
        </span>
      </div>

      {/* Track */}
      {open && (
        <div
          style={{
            position: "relative",
            height: 28,
          }}
        >
          {/* Axis */}
          <div
            aria-hidden
            style={{
              position: "absolute",
              top: 12,
              left: 0,
              right: 0,
              height: 1,
              background: "var(--bg-3)",
            }}
          />

          {/* Tick marks */}
          {TICKS.map((t) => {
            const pct = tickPct(t.hour, t.minute);
            return (
              <div
                key={t.label}
                aria-hidden
                style={{
                  position: "absolute",
                  left: `${pct}%`,
                  top: 8,
                  transform: "translateX(-50%)",
                  color: "var(--text-dim)",
                  fontSize: 9.5,
                  letterSpacing: "0.04em",
                  pointerEvents: "none",
                }}
              >
                <div
                  style={{
                    width: 1,
                    height: 6,
                    background: "var(--bg-3)",
                    margin: "0 auto 1px",
                  }}
                />
                {t.label}
              </div>
            );
          })}

          {/* NOW line */}
          <div
            aria-hidden
            style={{
              position: "absolute",
              left: `${nowPct}%`,
              top: 0,
              bottom: 0,
              width: 2,
              background: "var(--text)",
              transform: "translateX(-50%)",
              transition: "left 1s linear",
              zIndex: 2,
              boxShadow: "0 0 4px var(--text)",
            }}
          />

          {/* Event dots */}
          {events.map((e) => {
            const pct = timeToStripPct(e.at);
            const color = eventColor(e.outcome);
            const isImminent = e.outcome === "amber";
            const isFire =
              e.label === "extended-fire" || e.label === "market-fire";
            return (
              <button
                key={e.id}
                type="button"
                onClick={() => onJumpToFire?.(e.at)}
                title={eventTitle(e)}
                aria-label={eventTitle(e)}
                style={{
                  position: "absolute",
                  left: `${pct}%`,
                  top: 8,
                  transform: "translateX(-50%)",
                  width: isFire ? 12 : 8,
                  height: isFire ? 12 : 8,
                  borderRadius: 999,
                  background: color,
                  border: 0,
                  padding: 0,
                  cursor: "pointer",
                  animation: isImminent
                    ? "tp-pulse 1.6s ease-in-out infinite"
                    : "none",
                  zIndex: 1,
                }}
              >
                {/* Count overlay sits ABOVE the dot (negative top) so it
                  doesn't push the dot off the axis line. */}
                {e.count && (
                  <span
                    className="mono"
                    style={{
                      position: "absolute",
                      bottom: "calc(100% + 2px)",
                      left: "50%",
                      transform: "translateX(-50%)",
                      fontSize: 9,
                      color: "var(--text)",
                      background: "var(--bg-2)",
                      padding: "1px 4px",
                      borderRadius: 3,
                      pointerEvents: "none",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {e.count.done}/{e.count.total}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
