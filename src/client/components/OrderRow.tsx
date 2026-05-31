/**
 * Slice 4.2 OrderRow.
 *
 * One actionable order, rendered as a fixed-column CSS grid so columns
 * never jitter as data arrives. Three "tiers" passed via prop control
 * the visual emphasis:
 *
 *   - imminent  (firing within 30 min)  - amber left border, bigger
 *                                          amber time digits, tinted bg.
 *   - today     (default)                - normal density.
 *   - future    (later than today ET)    - dimmed.
 *
 * Filled rows render at 86% opacity (Brief §3.3): the user's eye should
 * land on imminent + rejected rows, not the green checkmarks.
 *
 * Hover reveals [Modify] [Pause] [Submit now]. Default state shows the
 * kebab. Imminent rejected rows render an inline error sub-row with the
 * mapped concrete error and a "Retry now" button.
 *
 * The row dispatches actions through callback props. The parent owns the
 * mutation hooks (so the hooks live exactly once per page); the row
 * stays presentational.
 */
import { type CSSProperties, useEffect, useState } from "react";
import { type Order } from "../utils/api";
import type { TransientOrderStatus } from "../hooks/useOrderMutations";
import { mapErrorToConcrete } from "../utils/errorMessages";

export type RowTier = "imminent" | "today" | "future";

export interface OrderRowProps {
  order: Order;
  tier: RowTier;
  onSubmit?: (id: string) => void;
  onPause?: (id: string) => void;
  onResume?: (id: string) => void;
  onModify?: (order: Order) => void;
  onDelete?: (id: string) => void;
  onRetry?: (id: string) => void;
  onCancelBrokerOrder?: (accountIdKey: string, brokerOrderId: string) => void;
  onToggleOnlyFillOnce?: (id: string, next: boolean) => void;
  /** True while a submit is pending for this row. */
  submittingId?: string | null;
}

/**
 * Visual treatment per status. Returns:
 *   bg / fg of the pill, dot color, whether the dot pulses.
 *
 * Transient (client-only) statuses live in the same map; OrderList sets
 * them via the optimistic mutation hooks while a request is in flight.
 */
type StatusKey = Order["status"] | TransientOrderStatus;

interface PillStyle {
  label: string;
  bg: string;
  fg: string;
  dot: string;
  pulse: boolean;
}

const PILLS: Record<StatusKey, PillStyle> = {
  SCHEDULED: {
    label: "scheduled",
    bg: "color-mix(in oklab, var(--accent) 20%, transparent)",
    fg: "var(--accent)",
    dot: "var(--accent)",
    pulse: false,
  },
  PENDING: {
    label: "pending",
    bg: "color-mix(in oklab, var(--accent) 18%, transparent)",
    fg: "var(--accent)",
    dot: "var(--accent)",
    pulse: false,
  },
  SUBMITTED: {
    label: "submitted",
    bg: "color-mix(in oklab, var(--info) 20%, transparent)",
    fg: "var(--info)",
    dot: "var(--info)",
    pulse: true,
  },
  FILLED: {
    label: "filled",
    bg: "color-mix(in oklab, var(--ok) 18%, transparent)",
    fg: "var(--ok)",
    dot: "var(--ok)",
    pulse: false,
  },
  PARTIALLY_FILLED: {
    label: "partial fill",
    bg: "color-mix(in oklab, var(--ok) 18%, transparent)",
    fg: "var(--ok)",
    dot: "var(--ok)",
    pulse: false,
  },
  REJECTED: {
    label: "rejected",
    bg: "color-mix(in oklab, var(--bad) 22%, transparent)",
    fg: "var(--bad)",
    dot: "var(--bad)",
    pulse: false,
  },
  CANCELLED: {
    label: "cancelled",
    bg: "color-mix(in oklab, var(--paused) 22%, transparent)",
    fg: "var(--text-dim)",
    dot: "var(--paused)",
    pulse: false,
  },
  EXPIRED: {
    label: "expired",
    bg: "color-mix(in oklab, var(--paused) 22%, transparent)",
    fg: "var(--text-dim)",
    dot: "var(--paused)",
    pulse: false,
  },
  PAUSED: {
    label: "paused",
    bg: "color-mix(in oklab, var(--paused) 26%, transparent)",
    fg: "var(--text-dim)",
    dot: "var(--paused)",
    pulse: false,
  },
  DELETED: {
    label: "deleted",
    bg: "color-mix(in oklab, var(--paused) 22%, transparent)",
    fg: "var(--text-dim)",
    dot: "var(--paused)",
    pulse: false,
  },
  SUBMITTING: {
    label: "submitting...",
    bg: "color-mix(in oklab, var(--info) 22%, transparent)",
    fg: "var(--info)",
    dot: "var(--info)",
    pulse: true,
  },
  DELETING: {
    label: "deleting...",
    bg: "color-mix(in oklab, var(--bad) 22%, transparent)",
    fg: "var(--bad)",
    dot: "var(--bad)",
    pulse: true,
  },
  PAUSING: {
    label: "pausing...",
    bg: "color-mix(in oklab, var(--accent) 22%, transparent)",
    fg: "var(--accent)",
    dot: "var(--accent)",
    pulse: true,
  },
  RESUMING: {
    label: "resuming...",
    bg: "color-mix(in oklab, var(--info) 22%, transparent)",
    fg: "var(--info)",
    dot: "var(--info)",
    pulse: true,
  },
};

function getPill(status: StatusKey): PillStyle {
  return PILLS[status] ?? PILLS.PENDING;
}

function actionTagStyle(action: Order["action"]): {
  borderColor: string;
  fg: string;
  label: string;
} {
  // BUY: green; everything else (SELL / SELL_SHORT / BUY_TO_COVER): red.
  // SELL_SHORT renders as SHORT; BUY_TO_COVER as COVER; matches the
  // redesign's outlined chip treatment.
  switch (action) {
    case "BUY":
      return { borderColor: "var(--ok)", fg: "var(--ok)", label: "BUY" };
    case "SELL":
      return { borderColor: "var(--bad)", fg: "var(--bad)", label: "SELL" };
    case "SELL_SHORT":
      return { borderColor: "var(--bad)", fg: "var(--bad)", label: "SHORT" };
    case "BUY_TO_COVER":
      return { borderColor: "var(--bad)", fg: "var(--bad)", label: "COVER" };
    default:
      return {
        borderColor: "var(--paused)",
        fg: "var(--text-dim)",
        label: action,
      };
  }
}

/** Format scheduledFor as HH:MM in ET. Falls back to "-" when missing. */
function formatTimeET(iso?: Date | string | null): string {
  if (!iso) return "-";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "in 7m", "today", "tomorrow", "Apr 28" - relative coarse hint under the time. */
function formatRelative(iso?: Date | string | null): string {
  if (!iso) return "";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "";
  const diffMs = d.getTime() - Date.now();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes >= 0 && minutes < 60)
    return minutes <= 1 ? "now" : `in ${minutes}m`;
  if (minutes < 0 && minutes > -60)
    return minutes >= -1 ? "now" : `${-minutes}m ago`;
  // Coarse: same calendar day in ET = "today".
  const dayKey = (x: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(x);
  if (dayKey(d) === dayKey(new Date())) return "today";
  const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
  if (dayKey(d) === dayKey(tomorrow)) return "tomorrow";
  return d.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  });
}

const GRID_TEMPLATE =
  // time | pill | action | instrument | price | live value | session | kebab
  "84px 110px 64px minmax(0,1fr) 92px 92px 90px 32px";

const GRID_TEMPLATE_MOBILE =
  // symbol + action on row 1, time + pill + price on row 2
  "1fr auto";

function useIsMobile(breakpoint = 640): boolean {
  const [mobile, setMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setMobile(e.matches);
    setMobile(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [breakpoint]);
  return mobile;
}

function estValue(order: Order): string {
  const price = order.limitPrice ?? order.stopPrice;
  if (price == null) return "—";
  const multiplier = order.securityType === "OPTION" ? 100 : 1;
  const val = order.quantity * price * multiplier;
  if (val >= 1_000_000) return "$" + (val / 1_000_000).toFixed(2) + "M";
  if (val >= 1_000) return "$" + (val / 1_000).toFixed(1) + "k";
  return "$" + val.toFixed(2);
}

interface RelatedBrokerOrder {
  orderId: string;
  line: string;
}

function relatedBrokerOrders(error: string | undefined): RelatedBrokerOrder[] {
  if (!error) return [];
  const lines = error.split(/\r?\n/);
  const orders: RelatedBrokerOrder[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const match = /^#(\d+)\s+/.exec(trimmed);
    if (match?.[1]) orders.push({ orderId: match[1], line: trimmed });
  }
  return orders;
}

export default function OrderRow({
  order,
  tier,
  onSubmit,
  onPause,
  onResume,
  onModify,
  onDelete,
  onRetry,
  onCancelBrokerOrder,
  onToggleOnlyFillOnce,
  submittingId,
}: OrderRowProps) {
  const [hover, setHover] = useState<boolean>(false);
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  const isMobile = useIsMobile();
  const pill = getPill(order.status as StatusKey);
  const action = actionTagStyle(order.action);

  const isFilled =
    order.status === "FILLED" || order.status === "PARTIALLY_FILLED";
  const isRejected =
    order.status === "REJECTED" || (!!order.lastError && tier === "today");
  const isPaused = order.status === "PAUSED";
  const isSubmitting =
    submittingId === order.id || order.status === "SUBMITTING";

  const showError = isRejected && tier === "today";
  const concreteError = showError ? mapErrorToConcrete(order.lastError) : "";
  const brokerOrders = showError ? relatedBrokerOrders(order.lastError) : [];

  const rowStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: GRID_TEMPLATE,
    alignItems: "center",
    gap: 12,
    position: "relative",
    padding: "10px 16px",
    borderBottom: "1px solid var(--bg-2)",
    background:
      tier === "imminent"
        ? "color-mix(in oklab, var(--accent) 8%, var(--bg-1))"
        : "var(--bg-1)",
    borderLeft:
      tier === "imminent" ? "3px solid var(--accent)" : "3px solid transparent",
    opacity: tier === "future" ? 0.7 : isFilled ? 0.86 : 1,
    transition: "background 120ms ease",
  };

  const timeBig: CSSProperties = {
    fontSize: tier === "imminent" ? 16 : 13,
    fontWeight: tier === "imminent" ? 700 : 500,
    color: tier === "imminent" ? "var(--accent)" : "var(--text)",
    fontFeatureSettings: "'tnum' 1",
    lineHeight: 1.1,
  };

  // ── Mobile layout: symbol prominent, compact 2-row card ──
  if (isMobile) {
    return (
      <div
        data-testid="order-row"
        data-fires-at={
          order.scheduledFor ? new Date(order.scheduledFor).toISOString() : ""
        }
        data-tier={tier}
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid var(--bg-2)",
          background:
            tier === "imminent"
              ? "color-mix(in oklab, var(--accent) 8%, var(--bg-1))"
              : "var(--bg-1)",
          borderLeft:
            tier === "imminent"
              ? "3px solid var(--accent)"
              : "3px solid transparent",
          opacity: tier === "future" ? 0.7 : isFilled ? 0.86 : 1,
        }}
      >
        {/* Row 1: symbol + action tag + status pill */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 6,
          }}
        >
          <span
            className="mono"
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: "var(--text)",
              letterSpacing: "0.02em",
            }}
          >
            {order.symbol}
          </span>
          <span
            className="mono"
            style={{
              display: "inline-block",
              fontSize: 10,
              padding: "2px 6px",
              borderRadius: 4,
              border: `1px solid ${action.borderColor}`,
              color: action.fg,
              fontWeight: 600,
            }}
          >
            {action.label}
          </span>
          <span
            className="mono"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 10,
              padding: "2px 6px",
              borderRadius: 999,
              background: pill.bg,
              color: pill.fg,
              whiteSpace: "nowrap",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 5,
                height: 5,
                borderRadius: 999,
                background: pill.dot,
                animation: pill.pulse
                  ? "tp-pulse 1.6s ease-in-out infinite"
                  : "none",
              }}
            />
            {pill.label}
          </span>
          <span style={{ flex: 1 }} />
          {/* Kebab on mobile */}
          {!isFilled && (
            <button
              type="button"
              aria-label="Row actions"
              onClick={() => setMenuOpen((v) => !v)}
              style={{
                background: menuOpen ? "var(--bg-2)" : "transparent",
                border: 0,
                color: "var(--text-dim)",
                fontSize: 16,
                cursor: "pointer",
                padding: "0 4px",
                borderRadius: 4,
              }}
            >
              ⋯
            </button>
          )}
        </div>
        {/* Action buttons (toggled by kebab tap) */}
        {menuOpen && !isFilled && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              padding: "6px 0 2px",
            }}
          >
            {!isPaused && (
              <RowAction
                label="Modify"
                onClick={() => {
                  onModify?.(order);
                  setMenuOpen(false);
                }}
              />
            )}
            {!isPaused && order.status !== "REJECTED" && (
              <RowAction
                label="Pause"
                onClick={() => {
                  onPause?.(order.id);
                  setMenuOpen(false);
                }}
              />
            )}
            {isPaused && (
              <RowAction
                label="Resume"
                onClick={() => {
                  onResume?.(order.id);
                  setMenuOpen(false);
                }}
              />
            )}
            {!isPaused && (
              <RowAction
                label={isSubmitting ? "Sending..." : "Submit now"}
                onClick={() => {
                  onSubmit?.(order.id);
                  setMenuOpen(false);
                }}
                primary
                disabled={isSubmitting}
              />
            )}
            {order.scheduleEnabled && !order.scheduleOnce && (
              <RowAction
                label={
                  order.onlyFillOnce
                    ? "Recurring (fills stop): on"
                    : "Recurring (fills stop): off"
                }
                onClick={() => {
                  onToggleOnlyFillOnce?.(order.id, !order.onlyFillOnce);
                  setMenuOpen(false);
                }}
              />
            )}
            <RowAction
              label="Delete"
              onClick={() => {
                onDelete?.(order.id);
                setMenuOpen(false);
              }}
              danger
            />
          </div>
        )}
        {/* Row 2: time, qty, price, session */}
        <div
          className="mono"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 11,
            color: "var(--text-dim)",
          }}
        >
          <span
            style={{
              color: tier === "imminent" ? "var(--accent)" : "var(--text)",
              fontWeight: tier === "imminent" ? 700 : 500,
              fontSize: 13,
              fontFeatureSettings: "'tnum' 1",
            }}
          >
            {formatTimeET(order.scheduledFor)}
          </span>
          <span>{formatRelative(order.scheduledFor)}</span>
          <span style={{ color: "var(--bg-3)" }}>·</span>
          <span>qty {order.quantity}</span>
          {order.limitPrice != null && (
            <>
              <span style={{ color: "var(--bg-3)" }}>·</span>
              <span>${order.limitPrice}</span>
            </>
          )}
          <span style={{ color: "var(--bg-3)" }}>·</span>
          <span>{order.orderType}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="order-row"
      data-fires-at={
        order.scheduledFor ? new Date(order.scheduledFor).toISOString() : ""
      }
      data-tier={tier}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div style={rowStyle}>
        {/* time */}
        <div className="mono">
          <div style={timeBig}>{formatTimeET(order.scheduledFor)}</div>
          <div
            style={{
              fontSize: 10,
              color: "var(--text-dim)",
              letterSpacing: "0.04em",
            }}
          >
            {formatRelative(order.scheduledFor)}
          </div>
        </div>

        {/* status pill */}
        <div>
          <span
            className="mono"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 10.5,
              padding: "3px 8px",
              borderRadius: 999,
              textTransform: "lowercase",
              letterSpacing: "0.02em",
              background: pill.bg,
              color: pill.fg,
              whiteSpace: "nowrap",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 5,
                height: 5,
                borderRadius: 999,
                background: pill.dot,
                animation: pill.pulse
                  ? "tp-pulse 1.6s ease-in-out infinite"
                  : "none",
              }}
            />
            {pill.label}
          </span>
        </div>

        {/* action tag */}
        <div>
          <span
            className="mono"
            style={{
              display: "inline-block",
              fontSize: 10.5,
              padding: "3px 8px",
              borderRadius: 4,
              border: `1px solid ${action.borderColor}`,
              color: action.fg,
              letterSpacing: "0.04em",
              fontWeight: 600,
            }}
          >
            {action.label}
          </span>
        </div>

        {/* instrument + meta */}
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 6,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            <span
              className="mono"
              style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}
            >
              {order.symbol}
            </span>
            {order.securityType === "OPTION" && (
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  color: "var(--text-dim)",
                  textTransform: "uppercase",
                }}
              >
                {order.optionType ?? "OPT"}
              </span>
            )}
          </div>
          <div
            className="mono"
            style={{
              fontSize: 10.5,
              color: "var(--text-dim)",
              letterSpacing: "0.02em",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            <span>qty {order.quantity}</span>
            {order.securityType === "OPTION" && order.strikePrice != null && (
              <>
                <span style={{ margin: "0 5px", color: "var(--bg-3)" }}>·</span>
                <span>${order.strikePrice}</span>
              </>
            )}
            {order.scheduleEnabled && (
              <>
                <span style={{ margin: "0 5px", color: "var(--bg-3)" }}>·</span>
                <span>
                  {order.scheduleOnce
                    ? "once"
                    : (order.scheduleFrequency ?? "DAILY").toLowerCase()}
                </span>
              </>
            )}
            {order.parentSymbol && order.parentSymbol !== order.symbol && (
              <>
                <span style={{ margin: "0 5px", color: "var(--bg-3)" }}>·</span>
                <span>from {order.parentSymbol}</span>
              </>
            )}
          </div>
        </div>

        {/* price */}
        <div className="mono" style={{ textAlign: "right" }}>
          <div style={{ fontSize: 13, color: "var(--text)" }}>
            {order.limitPrice != null
              ? `$${order.limitPrice}`
              : order.orderType}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
            {order.orderType}
          </div>
        </div>

        {/* est value */}
        <div className="mono" style={{ textAlign: "right" }}>
          <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
            {estValue(order)}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
            est value
          </div>
        </div>

        {/* session */}
        <div className="mono" style={{ textAlign: "right" }}>
          <span
            style={{
              fontSize: 10.5,
              color: "var(--text-dim)",
              letterSpacing: "0.04em",
            }}
          >
            {order.sessionTime}
          </span>
        </div>

        {/* kebab / hover actions */}
        <div style={{ textAlign: "right" }}>
          <button
            type="button"
            aria-label="Row actions"
            onClick={() => setMenuOpen((v) => !v)}
            style={{
              background: menuOpen ? "var(--bg-2)" : "transparent",
              border: 0,
              color: "var(--text-dim)",
              fontSize: 16,
              cursor: "pointer",
              padding: "0 4px",
              borderRadius: 4,
            }}
          >
            ⋯
          </button>
          {(hover || menuOpen) && !isFilled && (
            <div
              style={{
                position: "absolute",
                right: 48,
                top: "50%",
                transform: "translateY(-50%)",
                display: "flex",
                gap: 4,
                whiteSpace: "nowrap",
                zIndex: 10,
                background: "var(--bg-1)",
                padding: "4px 8px",
                borderRadius: 6,
                boxShadow: "-4px 0 12px var(--bg-1)",
              }}
            >
              {!isPaused && (
                <RowAction
                  label="Modify"
                  onClick={() => {
                    onModify?.(order);
                    setMenuOpen(false);
                  }}
                />
              )}
              {!isPaused && order.status !== "REJECTED" && (
                <RowAction
                  label="Pause"
                  onClick={() => {
                    onPause?.(order.id);
                    setMenuOpen(false);
                  }}
                />
              )}
              {isPaused && (
                <RowAction
                  label="Resume"
                  onClick={() => {
                    onResume?.(order.id);
                    setMenuOpen(false);
                  }}
                />
              )}
              {!isPaused && (
                <RowAction
                  label={isSubmitting ? "Sending..." : "Submit now"}
                  onClick={() => {
                    onSubmit?.(order.id);
                    setMenuOpen(false);
                  }}
                  primary
                  disabled={isSubmitting}
                />
              )}
              {order.scheduleEnabled && !order.scheduleOnce && (
                <RowAction
                  label={order.onlyFillOnce ? "OFO: on" : "OFO: off"}
                  onClick={() => {
                    onToggleOnlyFillOnce?.(order.id, !order.onlyFillOnce);
                    setMenuOpen(false);
                  }}
                />
              )}
              <RowAction
                label="Delete"
                onClick={() => {
                  onDelete?.(order.id);
                  setMenuOpen(false);
                }}
                danger
              />
            </div>
          )}
        </div>
      </div>

      {/* Inline error sub-row */}
      {showError && (
        <div
          className="mono"
          style={{
            padding: "6px 16px 8px 19px",
            background: "color-mix(in oklab, var(--bad) 8%, var(--bg-1))",
            borderBottom: "1px solid var(--bg-2)",
            borderLeft: "3px solid var(--bad)",
            fontSize: 11,
            color: "var(--bad)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span aria-hidden style={{ fontWeight: 700 }}>
              !
            </span>
            <span style={{ color: "var(--text)" }}>{concreteError}</span>
            {order.retryCount > 0 && (
              <span style={{ color: "var(--text-dim)" }}>
                · attempts {order.retryCount}/{order.maxRetries}
              </span>
            )}
            <span style={{ flex: 1 }} />
            <button
              type="button"
              onClick={() => onRetry?.(order.id)}
              style={{
                background: "var(--bad)",
                color: "var(--bg-0)",
                border: 0,
                borderRadius: 4,
                padding: "3px 10px",
                fontSize: 10.5,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Retry now
            </button>
          </div>
          {brokerOrders.length > 0 && (
            <div
              style={{
                marginTop: 6,
                marginLeft: 16,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              {brokerOrders.map((brokerOrder) => (
                <div
                  key={brokerOrder.orderId}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    color: "var(--text-dim)",
                  }}
                >
                  <button
                    type="button"
                    aria-label={`Cancel E*TRADE order ${brokerOrder.orderId}`}
                    title={`Cancel E*TRADE order ${brokerOrder.orderId}`}
                    onClick={() =>
                      onCancelBrokerOrder?.(
                        order.accountId,
                        brokerOrder.orderId,
                      )
                    }
                    style={{
                      width: 18,
                      height: 18,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: 4,
                      border: "1px solid var(--bad)",
                      background: "transparent",
                      color: "var(--bad)",
                      cursor: "pointer",
                      fontSize: 12,
                      lineHeight: 1,
                    }}
                  >
                    x
                  </button>
                  <span style={{ whiteSpace: "pre-wrap" }}>
                    {brokerOrder.line}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RowAction({
  label,
  onClick,
  primary,
  danger,
  disabled,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  const palette = primary
    ? { bg: "var(--text)", fg: "var(--bg-0)", border: "var(--text)" }
    : danger
      ? { bg: "transparent", fg: "var(--bad)", border: "var(--bad)" }
      : { bg: "transparent", fg: "var(--text)", border: "var(--bg-3)" };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="mono"
      style={{
        background: palette.bg,
        color: palette.fg,
        border: `1px solid ${palette.border}`,
        borderRadius: 4,
        padding: "3px 8px",
        fontSize: 10.5,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {label}
    </button>
  );
}
