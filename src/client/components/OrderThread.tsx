/**
 * Slice 4.3 OrderThread.
 *
 * Wraps a recurring parent order with its lineage rollup. Visual idea:
 * the parent row stays at the top exactly like an OrderRow; underneath
 * the row, a 6-cell horizontal lineage bar shows recent children colored
 * by outcome. Click the chevron to inline-expand the full child history.
 *
 * Auto-expand rule: if the most recent child run was rejected, the
 * thread renders expanded by default - the user shouldn't have to click
 * to find out their order failed.
 *
 * Network policy:
 *   - Collapsed: zero extra fetches. We render the 6-cell preview from
 *     the parent's `lineageCount` + a synthesized hint. The full history
 *     load happens on first expand.
 *   - Expanded: useChildOrders fires. WS order_update keeps the parent
 *     row's `lineageCount` / `lastFillAt` fresh via the existing setQueryData
 *     in WSProvider; the children list refreshes on tab focus.
 */
import { useMemo, useState } from "react";
import { type Order } from "../utils/api";
import { useChildOrders } from "../hooks/useChildOrders";
import OrderRow, { type OrderRowProps, type RowTier } from "./OrderRow";

interface OrderThreadProps {
  parent: Order;
  tier: RowTier;
  /** Forwarded to the parent row + each expanded child row. */
  rowHandlers: Omit<OrderRowProps, "order" | "tier">;
}

type CellOutcome = "ok" | "bad" | "amber" | "skip";

function classifyChild(c: Order): CellOutcome {
  if (c.status === "FILLED" || c.status === "PARTIALLY_FILLED") return "ok";
  if (c.status === "REJECTED" || c.lastError) return "bad";
  if (c.status === "PAUSED" || c.status === "CANCELLED") return "skip";
  return "amber";
}

function cellColor(o: CellOutcome): string {
  switch (o) {
    case "ok":
      return "var(--ok)";
    case "bad":
      return "var(--bad)";
    case "amber":
      return "var(--accent)";
    case "skip":
    default:
      return "var(--paused)";
  }
}

export default function OrderThread({ parent, tier, rowHandlers }: OrderThreadProps) {
  const lastErrorOnParent = !!parent.lastError;
  const [expanded, setExpanded] = useState<boolean>(lastErrorOnParent);

  const childrenQ = useChildOrders(expanded ? parent.id : null, 10);
  const children = childrenQ.data ?? [];

  // Auto-expand once after data arrives if the freshest child was rejected.
  // We only flip from collapsed -> expanded; we don't auto-collapse.
  const mostRecentRejected = useMemo(() => {
    if (children.length === 0) return false;
    return classifyChild(children[0]) === "bad";
  }, [children]);
  if (mostRecentRejected && !expanded) {
    // Defer state mutation to the next tick to avoid render-time setState.
    queueMicrotask(() => setExpanded(true));
  }

  // Six-cell preview. When we have children, color them by outcome,
  // newest-first, padding the leftover cells as "skip" (grey).
  const previewCells: CellOutcome[] = useMemo(() => {
    const cells: CellOutcome[] = [];
    const slice = children.slice(0, 6);
    for (const c of slice) cells.push(classifyChild(c));
    while (cells.length < 6) cells.push("skip");
    return cells;
  }, [children]);

  const lineageCount = parent.lineageCount ?? 0;
  const lastFillAt = parent.lastFillAt ? new Date(parent.lastFillAt) : null;

  return (
    <div data-testid="order-thread">
      {/* Parent row: same OrderRow treatment, with a chevron hint in the
          instrument cell handled by appending a "thread" badge below. The
          existing OrderRow stays unchanged; we render the lineage bar as
          a sibling row that shares the visual border. */}
      <OrderRow order={parent} tier={tier} {...rowHandlers} />

      {/* Lineage bar - sits just under the parent row. */}
      <div
        className="mono"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 16px 8px 56px",
          background: "var(--bg-1)",
          borderBottom: "1px solid var(--bg-2)",
          fontSize: 10.5,
          color: "var(--text-dim)",
          letterSpacing: "0.04em",
        }}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? "Collapse lineage" : "Expand lineage"}
          style={{
            background: "transparent",
            border: 0,
            color: "var(--text-dim)",
            cursor: "pointer",
            padding: 0,
            fontSize: 10.5,
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <span
            aria-hidden
            style={{
              display: "inline-block",
              transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform 120ms ease",
            }}
          >
            ▸
          </span>
          <span>{lineageCount} runs</span>
        </button>

        <span style={{ color: "var(--bg-3)" }}>·</span>

        <span style={{ display: "inline-flex", gap: 3 }} aria-label="Lineage outcomes">
          {previewCells.map((c, i) => (
            <span
              key={i}
              aria-hidden
              style={{
                width: 14,
                height: 8,
                borderRadius: 2,
                background: cellColor(c),
                opacity: c === "skip" ? 0.35 : 1,
              }}
            />
          ))}
        </span>

        {lastFillAt && (
          <>
            <span style={{ color: "var(--bg-3)" }}>·</span>
            <span>last fill {formatLineageTime(lastFillAt)}</span>
          </>
        )}
      </div>

      {/* Expanded child list */}
      {expanded && (
        <div
          style={{
            background: "var(--bg-1)",
            borderBottom: "1px solid var(--bg-2)",
          }}
        >
          {childrenQ.isLoading && (
            <div
              className="mono"
              style={{
                padding: "10px 56px",
                fontSize: 11,
                color: "var(--text-dim)",
              }}
            >
              loading lineage...
            </div>
          )}
          {!childrenQ.isLoading && children.length === 0 && (
            <div
              className="mono"
              style={{
                padding: "10px 56px",
                fontSize: 11,
                color: "var(--text-dim)",
              }}
            >
              no past runs yet
            </div>
          )}
          {children.map((child) => (
            <ChildLine key={child.id} child={child} />
          ))}
        </div>
      )}
    </div>
  );
}

function ChildLine({ child }: { child: Order }) {
  const outcome = classifyChild(child);
  const color = cellColor(outcome);
  const when = child.filledAt
    ? new Date(child.filledAt)
    : child.scheduledFor
      ? new Date(child.scheduledFor)
      : new Date(child.createdAt);
  return (
    <div
      className="mono"
      style={{
        display: "grid",
        gridTemplateColumns: "120px 80px 1fr 100px",
        alignItems: "center",
        gap: 12,
        padding: "6px 56px",
        borderTop: "1px dashed var(--bg-2)",
        fontSize: 11,
        color: "var(--text-dim)",
      }}
    >
      <span>{when.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}</span>
      <span style={{ color, textTransform: "lowercase" }}>{child.status}</span>
      <span style={{ color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {child.lastError ?? `qty ${child.quantity}`}
      </span>
      <span style={{ textAlign: "right", color: "var(--text-dim)" }}>
        {child.limitPrice != null ? `$${child.limitPrice}` : child.orderType}
      </span>
    </div>
  );
}

function formatLineageTime(d: Date): string {
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
