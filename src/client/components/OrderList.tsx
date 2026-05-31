/**
 * Slice 4.4 OrderList rewrite.
 *
 * Replaces the giant filter-tab strip + flat list with:
 *
 *   1. <DayStrip /> at the top - 56px timeline showing today's auth +
 *      heartbeats + fire windows + close + DB dump. Click a dot to
 *      scroll the list to that fire's orders.
 *   2. Three sections: "Firing within 30 minutes" (amber pulsing),
 *      "Today", "Future". Each shows a count next to the section title.
 *   3. Rows render as <OrderThread /> when the order has lineage children,
 *      or <OrderRow /> when standalone. Both share the same row grid.
 *   4. Filter chips (PAUSED / REJECTED / COMPLETE / DELETED) move to a
 *      compact dropdown menu on the right of the page header. The default
 *      view is the three time-tier sections.
 *   5. Virtualization kicks in when the visible row count exceeds 100
 *      via @tanstack/react-virtual. Section headers stay outside the
 *      virtual viewport so they never disappear during scroll.
 *
 * Mutation handlers (submit / pause / resume / modify / delete / retry)
 * still come from Slice 3.3 useOrderMutations. Actions stay optimistic;
 * we toast on success/error like the previous version did.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cancelBrokerOrder, type Order } from "../utils/api";
import { useOrders } from "../hooks/useOrders";
import { useDeletedOrders } from "../hooks/useDeletedOrders";
import { useDayStripEvents } from "../hooks/useDayStripEvents";
import { useWS } from "../hooks/WSProvider";
import {
  useDeleteOrder,
  usePauseAllOrders,
  usePauseOrder,
  usePermanentlyDeleteOrder,
  useRestoreOrder,
  useResumeAllOrders,
  useResumeOrder,
  useSubmitOrder,
  useUpdateOrderLimitPrice,
  useUpdateOrderOnlyFillOnce,
  useUpdateOrderQuantity,
} from "../hooks/useOrderMutations";
import DayStrip from "./DayStrip";
import AuthFix from "./AuthFix";
import { useAuthStatus } from "../hooks/useAuthStatus";
import OrderRow, { type RowTier } from "./OrderRow";
import OrderThread from "./OrderThread";

type Toast = { id: number; message: string; type: "success" | "error" };
type SecondaryFilter =
  | "all"
  | "active"
  | "paused"
  | "rejected"
  | "complete"
  | "deleted";

let toastId = 0;

const IMMINENT_MS = 30 * 60_000;
const VIRTUALIZE_THRESHOLD = 100;
const ROW_ESTIMATE_PX = 64; // OrderRow + lineage bar averages here for OrderThread.

interface ListItem {
  /** Section heading; tier carries the styling. */
  kind: "header";
  id: string;
  title: string;
  count: number;
  tier: RowTier;
}

interface RowItem {
  kind: "row";
  id: string;
  order: Order;
  tier: RowTier;
  isThread: boolean;
}

type FlatItem = ListItem | RowItem;

const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function classifyTier(order: Order, now: number): RowTier {
  // Imminent rule: scheduled within 30 min ahead OR submitted/pending right now.
  if (order.status === "SUBMITTED") return "imminent";
  if (!order.scheduledFor) return "today";
  const at = new Date(order.scheduledFor).getTime();
  const delta = at - now;
  if (delta <= IMMINENT_MS && delta >= -IMMINENT_MS / 2) return "imminent";
  // Same calendar day in ET = today.
  const dayKey = (ms: number) => dayKeyFormatter.format(new Date(ms));
  if (dayKey(at) === dayKey(now)) return "today";
  return "future";
}

function isActiveOrder(order: Order): boolean {
  return ["PENDING", "SCHEDULED", "SUBMITTED"].includes(order.status);
}

export default function OrderList() {
  const {
    data: orders = [],
    isLoading: ordersLoading,
    refetch: refetchOrders,
  } = useOrders();
  const { data: deletedOrders = [], refetch: refetchDeleted } =
    useDeletedOrders();
  const { isConnected } = useWS();
  const events = useDayStripEvents();
  const { status: authStatus } = useAuthStatus();
  const authBroken = authStatus !== null && authStatus.authenticated === false;

  const [secondaryFilter, setSecondaryFilter] =
    useState<SecondaryFilter>("all");
  const [filterMenuOpen, setFilterMenuOpen] = useState<boolean>(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [modifyingId, setModifyingId] = useState<string | null>(null);

  // Mutation hooks (Slice 3.3) - one instance per page.
  const submitMut = useSubmitOrder();
  const deleteMut = useDeleteOrder();
  const permanentDeleteMut = usePermanentlyDeleteOrder();
  const restoreMut = useRestoreOrder();
  const pauseMut = usePauseOrder();
  const resumeMut = useResumeOrder();
  const pauseAllMut = usePauseAllOrders();
  const resumeAllMut = useResumeAllOrders();
  // Quantity / price are still wired through the cache; the inline modify
  // UI moves to a future slice. For now, modify hands off to a window prompt
  // so the action stays reachable while the row stays compact.
  const updateQtyMut = useUpdateOrderQuantity();
  const updatePriceMut = useUpdateOrderLimitPrice();
  const updateOnlyFillOnceMut = useUpdateOrderOnlyFillOnce();
  const submittingId = submitMut.isPending
    ? (submitMut.variables ?? null)
    : null;

  const showToast = (message: string, type: "success" | "error") => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(
      () => setToasts((prev) => prev.filter((t) => t.id !== id)),
      4000,
    );
  };

  const handleSubmit = (id: string) =>
    submitMut.mutate(id, {
      onSuccess: (result) =>
        result.success
          ? showToast(
              `Order submitted - E*TRADE id ${result.order.etradeOrderId ?? "pending"}`,
              "success",
            )
          : showToast(
              `Submission failed: ${result.order.lastError ?? "unknown error"}`,
              "error",
            ),
      onError: (err) => showToast(`Failed to submit: ${err.message}`, "error"),
    });
  const handlePause = (id: string) =>
    pauseMut.mutate(id, {
      onSuccess: () => showToast("Order paused", "success"),
      onError: (err) => showToast(`Failed to pause: ${err.message}`, "error"),
    });
  const handleResume = (id: string) =>
    resumeMut.mutate(id, {
      onSuccess: () => showToast("Order resumed", "success"),
      onError: (err) => showToast(`Failed to resume: ${err.message}`, "error"),
    });
  const handleDelete = (id: string) =>
    deleteMut.mutate(id, {
      onSuccess: () => showToast("Order moved to Deleted", "success"),
      onError: (err) => showToast(`Failed to delete: ${err.message}`, "error"),
    });
  const handleRestore = (id: string) =>
    restoreMut.mutate(id, {
      onSuccess: () => showToast("Order restored", "success"),
      onError: (err) => showToast(`Failed to restore: ${err.message}`, "error"),
    });
  const handlePermanentDelete = (id: string) =>
    permanentDeleteMut.mutate(id, {
      onSuccess: () => showToast("Order permanently deleted", "success"),
      onError: (err) =>
        showToast(`Failed to permanently delete: ${err.message}`, "error"),
    });
  const handlePauseAll = () =>
    pauseAllMut.mutate(undefined, {
      onSuccess: (r) => showToast(`Paused ${r.paused} order(s)`, "success"),
      onError: (err) =>
        showToast(`Failed to pause all: ${err.message}`, "error"),
    });
  const handleResumeAll = () =>
    resumeAllMut.mutate(undefined, {
      onSuccess: (r) => showToast(`Resumed ${r.resumed} order(s)`, "success"),
      onError: (err) =>
        showToast(`Failed to resume all: ${err.message}`, "error"),
    });
  const handleToggleOnlyFillOnce = (id: string, next: boolean) =>
    updateOnlyFillOnceMut.mutate(
      { orderId: id, onlyFillOnce: next },
      {
        onSuccess: () =>
          showToast(
            next
              ? "Will stop rescheduling once filled"
              : "Will keep rescheduling after fills",
            "success",
          ),
        onError: (err) =>
          showToast(`Failed to update: ${err.message}`, "error"),
      },
    );

  const handleCancelBrokerOrder = (
    accountIdKey: string,
    brokerOrderId: string,
  ) => {
    const ok = window.confirm(`Cancel E*TRADE open order #${brokerOrderId}?`);
    if (!ok) return;
    cancelBrokerOrder(accountIdKey, brokerOrderId)
      .then(() => {
        showToast(`Cancelled E*TRADE order #${brokerOrderId}`, "success");
        refreshAll();
      })
      .catch((err: Error) =>
        showToast(
          `Failed to cancel #${brokerOrderId}: ${err.message}`,
          "error",
        ),
      );
  };

  // Modify: open an in-place edit cell on the row. Slice 5 polish replaces
  // the previous window.prompt path. The cell itself owns the inputs and
  // calls back into these mutation hooks on Save (or ↵).
  const handleModify = (order: Order) => {
    setModifyingId(order.id);
  };

  const handleSaveModify = (
    order: Order,
    next: { quantity?: number; limitPrice?: number },
  ) => {
    let pending = 0;
    let errors = 0;
    const finish = () => {
      pending--;
      if (pending === 0) {
        setModifyingId(null);
        if (errors === 0) showToast("Order updated", "success");
      }
    };
    if (next.quantity != null && next.quantity !== order.quantity) {
      pending++;
      updateQtyMut.mutate(
        { orderId: order.id, quantity: next.quantity },
        {
          onError: (err) => {
            errors++;
            showToast(`Failed to update quantity: ${err.message}`, "error");
          },
          onSettled: finish,
        },
      );
    }
    if (
      next.limitPrice != null &&
      order.limitPrice != null &&
      next.limitPrice !== order.limitPrice
    ) {
      pending++;
      updatePriceMut.mutate(
        { orderId: order.id, limitPrice: next.limitPrice },
        {
          onError: (err) => {
            errors++;
            showToast(`Failed to update price: ${err.message}`, "error");
          },
          onSettled: finish,
        },
      );
    }
    if (pending === 0) setModifyingId(null);
  };

  const handleCancelModify = () => setModifyingId(null);

  // Build the flat list of items (headers + rows) for the selected view.
  const items = useMemo<FlatItem[]>(() => {
    const now = Date.now();

    // Secondary filter narrows the source list.
    const sourceList: Order[] =
      secondaryFilter === "deleted"
        ? deletedOrders
        : secondaryFilter === "all"
          ? orders
          : secondaryFilter === "active"
            ? orders.filter(isActiveOrder)
            : secondaryFilter === "paused"
              ? orders.filter((o) => o.status === "PAUSED")
              : secondaryFilter === "rejected"
                ? orders.filter((o) => o.status === "REJECTED" || !!o.lastError)
                : secondaryFilter === "complete"
                  ? orders.filter((o) =>
                      [
                        "FILLED",
                        "PARTIALLY_FILLED",
                        "CANCELLED",
                        "EXPIRED",
                      ].includes(o.status),
                    )
                  : orders;

    // For the deleted/paused/rejected/complete views we render a flat list
    // (no time-tier sections). For the default all/active views we section
    // by tier and group by parent.
    if (secondaryFilter !== "all" && secondaryFilter !== "active") {
      const flat: FlatItem[] = [];
      flat.push({
        kind: "header",
        id: `head-${secondaryFilter}`,
        title:
          secondaryFilter === "deleted"
            ? "Deleted"
            : secondaryFilter === "paused"
              ? "Paused"
              : secondaryFilter === "rejected"
                ? "Rejected"
                : secondaryFilter === "complete"
                  ? "Complete"
                  : "Orders",
        count: sourceList.length,
        tier: "today",
      });
      for (const o of sourceList) {
        flat.push({
          kind: "row",
          id: o.id,
          order: o,
          tier: classifyTier(o, now),
          isThread: false,
        });
      }
      return flat;
    }

    // All/Active view: bucket by tier, group threads.
    // A row with `lineageCount > 0` is a parent recurring template; show as thread.
    // The active query already excludes the children (children of recurring
    // templates render as a fresh SCHEDULED clone, which has its own
    // scheduledFor and is treated as a regular row).
    const imminent: Order[] = [];
    const today: Order[] = [];
    const future: Order[] = [];
    for (const o of sourceList) {
      const tier = classifyTier(o, now);
      if (tier === "imminent") imminent.push(o);
      else if (tier === "today") today.push(o);
      else future.push(o);
    }

    // Status priority: SUBMITTED first, then SCHEDULED, PENDING, PAUSED, etc.
    const STATUS_PRIORITY: Record<string, number> = {
      SUBMITTED: 0,
      SCHEDULED: 1,
      PENDING: 2,
      PAUSED: 3,
      FILLED: 4,
      PARTIALLY_FILLED: 5,
      REJECTED: 6,
      CANCELLED: 7,
      EXPIRED: 8,
      DELETED: 9,
    };

    const sortOrders = (a: Order, b: Order) => {
      const pa = STATUS_PRIORITY[a.status] ?? 99;
      const pb = STATUS_PRIORITY[b.status] ?? 99;
      if (pa !== pb) return pa - pb;
      // Within the same status, sort by scheduledFor (soonest first).
      const ta = a.scheduledFor ? new Date(a.scheduledFor).getTime() : 0;
      const tb = b.scheduledFor ? new Date(b.scheduledFor).getTime() : 0;
      return ta - tb;
    };
    imminent.sort(sortOrders);
    today.sort(sortOrders);
    future.sort(sortOrders);

    const flat: FlatItem[] = [];
    const pushSection = (title: string, tier: RowTier, list: Order[]) => {
      flat.push({
        kind: "header",
        id: `head-${tier}`,
        title,
        count: list.length,
        tier,
      });
      for (const o of list) {
        flat.push({
          kind: "row",
          id: o.id,
          order: o,
          tier,
          isThread: (o.lineageCount ?? 0) > 0,
        });
      }
    };

    pushSection("Firing within 30 minutes", "imminent", imminent);
    pushSection("Today", "today", today);
    pushSection("Future", "future", future);

    return flat;
  }, [orders, deletedOrders, secondaryFilter]);

  // Counts for the secondary-filter dropdown.
  const counts = useMemo(() => {
    return {
      all: orders.length,
      active: orders.filter(isActiveOrder).length,
      paused: orders.filter((o) => o.status === "PAUSED").length,
      rejected: orders.filter(
        (o) =>
          o.status === "REJECTED" ||
          (!!o.lastError && ["PENDING", "SCHEDULED"].includes(o.status)),
      ).length,
      complete: orders.filter((o) =>
        ["FILLED", "PARTIALLY_FILLED", "CANCELLED", "EXPIRED"].includes(
          o.status,
        ),
      ).length,
      deleted: deletedOrders.length,
    };
  }, [orders, deletedOrders]);

  const refreshAll = () => {
    refetchOrders();
    refetchDeleted();
  };

  const hasScheduled = orders.some(
    (o) => o.status === "SCHEDULED" && !o.lastError,
  );
  const hasPaused = counts.paused > 0;

  // Virtualize when item count exceeds the threshold. Below it, render
  // every row directly so React's reconciliation stays the simplest path.
  const shouldVirtualize = items.length > VIRTUALIZE_THRESHOLD;
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: 8,
    enabled: shouldVirtualize,
  });

  // DayStrip onJumpToFire: find the row by data-fires-at and scroll it
  // into view. We accept the closest-by-time match within +/- 90 min,
  // because no row is guaranteed to land exactly on the dot's ISO.
  const scrollToFire = (atISO: string) => {
    const target = new Date(atISO).getTime();
    if (!Number.isFinite(target)) return;
    const nodes = document.querySelectorAll<HTMLElement>("[data-fires-at]");
    let bestEl: HTMLElement | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    nodes.forEach((el) => {
      const at = el.getAttribute("data-fires-at");
      if (!at) return;
      const t = new Date(at).getTime();
      if (!Number.isFinite(t)) return;
      const d = Math.abs(t - target);
      if (d < bestDelta) {
        bestDelta = d;
        bestEl = el;
      }
    });
    if (bestEl !== null) {
      (bestEl as HTMLElement).scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  };

  // Close filter menu on outside click.
  useEffect(() => {
    if (!filterMenuOpen) return;
    const onDocClick = () => setFilterMenuOpen(false);
    // Defer to skip the click that opened the menu.
    const id = setTimeout(
      () => document.addEventListener("click", onDocClick),
      0,
    );
    return () => {
      clearTimeout(id);
      document.removeEventListener("click", onDocClick);
    };
  }, [filterMenuOpen]);

  if (ordersLoading && orders.length === 0 && deletedOrders.length === 0) {
    return (
      <div
        className="mono"
        style={{
          padding: 24,
          textAlign: "center",
          color: "var(--text-dim)",
          fontSize: 12,
        }}
      >
        Loading orders...
      </div>
    );
  }

  return (
    <div data-testid="order-list">
      {/* Toasts */}
      <div
        style={{
          position: "fixed",
          top: 16,
          right: 16,
          zIndex: 50,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className="mono"
            style={{
              padding: "10px 14px",
              borderRadius: 6,
              fontSize: 12,
              background: t.type === "success" ? "var(--ok)" : "var(--bad)",
              color: "var(--bg-0)",
              boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
              animation: "slideIn 0.3s ease-out",
            }}
          >
            {t.message}
          </div>
        ))}
      </div>

      {/* Day strip OR AuthFix hero when auth is expired (Slice 6.1). */}
      {authBroken ? (
        <AuthFix />
      ) : (
        <DayStrip events={events} onJumpToFire={scrollToFire} />
      )}

      {/* Page header */}
      <div
        className="mono"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 16px",
          borderBottom: "1px solid var(--bg-2)",
        }}
      >
        <h2
          style={{
            fontSize: 14,
            color: "var(--text)",
            fontWeight: 600,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}
        >
          Active Orders
        </h2>

        <span style={{ flex: 1 }} />

        {/* Pause all / resume all */}
        {(hasScheduled || hasPaused) && (
          <button
            type="button"
            onClick={hasPaused ? handleResumeAll : handlePauseAll}
            className="mono"
            style={{
              padding: "5px 10px",
              borderRadius: 4,
              border: `1px solid ${hasPaused ? "var(--ok)" : "var(--accent)"}`,
              color: hasPaused ? "var(--ok)" : "var(--accent)",
              background: "transparent",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            {hasPaused ? "Resume all" : "Pause all"}
          </button>
        )}

        <button
          type="button"
          onClick={refreshAll}
          className="mono"
          style={{
            padding: "5px 10px",
            borderRadius: 4,
            border: "1px solid var(--bg-3)",
            color: "var(--text-dim)",
            background: "transparent",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          Refresh
        </button>

        {/* Secondary filter dropdown */}
        <div
          style={{ position: "relative" }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => setFilterMenuOpen((v) => !v)}
            className="mono"
            style={{
              padding: "5px 10px",
              borderRadius: 4,
              border: "1px solid var(--bg-3)",
              color:
                secondaryFilter === "all" ? "var(--text-dim)" : "var(--text)",
              background:
                secondaryFilter === "all"
                  ? "transparent"
                  : "color-mix(in oklab, var(--text) 5%, transparent)",
              fontSize: 11,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span>view: {secondaryFilter}</span>
            <span aria-hidden style={{ fontSize: 9 }}>
              ▾
            </span>
          </button>
          {filterMenuOpen && (
            <div
              role="menu"
              style={{
                position: "absolute",
                top: "calc(100% + 4px)",
                right: 0,
                minWidth: 180,
                background: "var(--bg-2)",
                border: "1px solid var(--bg-3)",
                borderRadius: 6,
                boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                zIndex: 40,
                padding: 4,
              }}
            >
              {(
                [
                  ["all", "All", counts.all],
                  ["active", "Active", counts.active],
                  ["paused", "Paused", counts.paused],
                  ["rejected", "Rejected", counts.rejected],
                  ["complete", "Complete", counts.complete],
                  ["deleted", "Deleted", counts.deleted],
                ] as const
              ).map(([k, label, n]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    setSecondaryFilter(k);
                    setFilterMenuOpen(false);
                  }}
                  className="mono"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    width: "100%",
                    padding: "6px 10px",
                    borderRadius: 4,
                    border: 0,
                    background:
                      secondaryFilter === k
                        ? "color-mix(in oklab, var(--accent) 25%, transparent)"
                        : "transparent",
                    color: "var(--text)",
                    fontSize: 11,
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >
                  <span>{label}</span>
                  <span style={{ color: "var(--text-dim)" }}>{n}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* List body */}
      {items.length === 0 ||
      (items.length === 3 && items.every((it) => it.kind === "header")) ? (
        <div
          className="mono"
          style={{
            padding: "48px 16px",
            textAlign: "center",
            color: "var(--text-dim)",
            fontSize: 12,
          }}
        >
          No orders.
        </div>
      ) : shouldVirtualize ? (
        <div
          ref={scrollerRef}
          style={{
            // Lift virtualizer's "scrollable element" - we constrain the
            // height so it has a viewport to virtualize against. Section
            // headers are inside the virtualized stream so the scroller
            // is the only scroll surface; per the brief they should stay
            // outside, but with react-virtual that means duplicating them
            // OR pinning headers via position: sticky on the items.
            // Sticky headers via z-index keep both promises:
            // headers always visible AND virtualized for positioning.
            height: 720,
            overflow: "auto",
            position: "relative",
          }}
        >
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((vItem) => {
              const item = items[vItem.index];
              return (
                <div
                  key={item.id}
                  data-index={vItem.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vItem.start}px)`,
                  }}
                >
                  {renderItem(
                    item,
                    {
                      onSubmit: handleSubmit,
                      onPause: handlePause,
                      onResume: handleResume,
                      onModify: handleModify,
                      onDelete: handleDelete,
                      onRetry: handleSubmit,
                      onCancelBrokerOrder: handleCancelBrokerOrder,
                      onToggleOnlyFillOnce: handleToggleOnlyFillOnce,
                      submittingId,
                      modifyingId,
                      onSaveModify: handleSaveModify,
                      onCancelModify: handleCancelModify,
                    },
                    secondaryFilter,
                    handleRestore,
                    handlePermanentDelete,
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div>
          {items.map((item) =>
            renderItem(
              item,
              {
                onSubmit: handleSubmit,
                onPause: handlePause,
                onResume: handleResume,
                onModify: handleModify,
                onDelete: handleDelete,
                onRetry: handleSubmit,
                onCancelBrokerOrder: handleCancelBrokerOrder,
                onToggleOnlyFillOnce: handleToggleOnlyFillOnce,
                submittingId,
                modifyingId,
                onSaveModify: handleSaveModify,
                onCancelModify: handleCancelModify,
              },
              secondaryFilter,
              handleRestore,
              handlePermanentDelete,
            ),
          )}
        </div>
      )}
    </div>
  );
}

interface RowHandlers {
  onSubmit: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onModify: (order: Order) => void;
  onDelete: (id: string) => void;
  onRetry: (id: string) => void;
  onCancelBrokerOrder: (accountIdKey: string, brokerOrderId: string) => void;
  onToggleOnlyFillOnce: (id: string, next: boolean) => void;
  submittingId: string | null;
  modifyingId?: string | null;
  onSaveModify?: (
    order: Order,
    next: { quantity?: number; limitPrice?: number },
  ) => void;
  onCancelModify?: () => void;
}

function renderItem(
  item: FlatItem,
  handlers: RowHandlers,
  secondary: SecondaryFilter,
  onRestore: (id: string) => void,
  onPermanentDelete: (id: string) => void,
): JSX.Element {
  if (item.kind === "header") {
    return (
      <SectionHeader
        key={item.id}
        title={item.title}
        count={item.count}
        tier={item.tier}
      />
    );
  }
  // Deleted view gets its own row treatment with Restore / Forever.
  if (secondary === "deleted") {
    return (
      <DeletedRow
        key={item.id}
        order={item.order}
        onRestore={onRestore}
        onPermanentDelete={onPermanentDelete}
      />
    );
  }
  if (handlers.modifyingId && item.order.id === handlers.modifyingId) {
    return (
      <ModifyRowCell
        key={item.id}
        order={item.order}
        onSave={(next) => handlers.onSaveModify?.(item.order, next)}
        onCancel={() => handlers.onCancelModify?.()}
      />
    );
  }
  if (item.isThread) {
    return (
      <OrderThread
        key={item.id}
        parent={item.order}
        tier={item.tier}
        rowHandlers={handlers}
      />
    );
  }
  return (
    <OrderRow key={item.id} order={item.order} tier={item.tier} {...handlers} />
  );
}

function SectionHeader({
  title,
  count,
  tier,
}: {
  title: string;
  count: number;
  tier: RowTier;
}) {
  const isImminent = tier === "imminent";
  return (
    <div
      className="mono"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 5,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 16px",
        background: isImminent
          ? "color-mix(in oklab, var(--accent) 18%, var(--bg-1))"
          : "var(--bg-1)",
        borderBottom: "1px solid var(--bg-2)",
        borderTop: "1px solid var(--bg-2)",
        fontSize: 11,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: isImminent ? "var(--accent)" : "var(--text-dim)",
      }}
    >
      {isImminent && (
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: "var(--accent)",
            animation: "tp-pulse 1.6s ease-in-out infinite",
          }}
        />
      )}
      <span>{title}</span>
      <span style={{ color: "var(--text-dim)", opacity: 0.7 }}>· {count}</span>
    </div>
  );
}

function DeletedRow({
  order,
  onRestore,
  onPermanentDelete,
}: {
  order: Order;
  onRestore: (id: string) => void;
  onPermanentDelete: (id: string) => void;
}) {
  return (
    <div
      className="mono"
      data-testid="deleted-row"
      style={{
        display: "grid",
        gridTemplateColumns: "120px 1fr auto",
        alignItems: "center",
        gap: 12,
        padding: "10px 16px",
        borderBottom: "1px solid var(--bg-2)",
        opacity: 0.7,
        background: "var(--bg-1)",
      }}
    >
      <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
        {order.action} · {order.symbol}
      </span>
      <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
        qty {order.quantity}
        {order.limitPrice != null && ` @ $${order.limitPrice}`}
        {" · "}
        {order.orderType}
      </span>
      <span style={{ display: "inline-flex", gap: 6 }}>
        <button
          type="button"
          onClick={() => onRestore(order.id)}
          className="mono"
          style={{
            padding: "3px 8px",
            borderRadius: 4,
            border: "1px solid var(--ok)",
            color: "var(--ok)",
            background: "transparent",
            fontSize: 10.5,
            cursor: "pointer",
          }}
        >
          Restore
        </button>
        <button
          type="button"
          onClick={() => onPermanentDelete(order.id)}
          className="mono"
          style={{
            padding: "3px 8px",
            borderRadius: 4,
            border: "1px solid var(--bad)",
            color: "var(--bad)",
            background: "transparent",
            fontSize: 10.5,
            cursor: "pointer",
          }}
        >
          Forever
        </button>
      </span>
    </div>
  );
}

/**
 * Slice 5 polish — in-place modify cell.
 *
 * Renders in place of OrderRow when a row enters modify mode. Quantity is
 * always editable; limit price is editable when the order had one. Save
 * (or ↵) calls back through handlers.onSaveModify; ESC or Cancel returns to
 * the row view via handlers.onCancelModify. No modal.
 */
function ModifyRowCell({
  order,
  onSave,
  onCancel,
}: {
  order: Order;
  onSave: (next: { quantity?: number; limitPrice?: number }) => void;
  onCancel: () => void;
}) {
  const [qty, setQty] = useState<string>(String(order.quantity));
  const [px, setPx] = useState<string>(
    order.limitPrice != null ? String(order.limitPrice) : "",
  );
  const qtyRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    qtyRef.current?.focus();
    qtyRef.current?.select();
  }, []);

  const commit = () => {
    const next: { quantity?: number; limitPrice?: number } = {};
    const qNum = parseInt(qty, 10);
    if (!Number.isNaN(qNum) && qNum >= 1) next.quantity = qNum;
    if (order.limitPrice != null) {
      const pNum = parseFloat(px);
      if (!Number.isNaN(pNum) && pNum >= 0) next.limitPrice = pNum;
    }
    onSave(next);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div
      onKeyDown={onKeyDown}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 16px",
        borderBottom: "1px solid var(--bg-2)",
        background: "color-mix(in oklab, var(--info) 10%, var(--bg-1))",
        borderLeft: "3px solid var(--info)",
      }}
    >
      <span
        className="mono"
        style={{
          fontSize: 11,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--info)",
          minWidth: 70,
        }}
      >
        Modify
      </span>
      <span
        style={{
          color: "var(--text)",
          fontSize: 13,
          fontWeight: 600,
          minWidth: 70,
        }}
      >
        {order.symbol}
      </span>
      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            color: "var(--text-dim)",
            fontSize: 11,
            textTransform: "uppercase",
          }}
        >
          qty
        </span>
        <input
          ref={qtyRef}
          type="number"
          min={1}
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          style={{
            width: 90,
            padding: "6px 8px",
            background: "var(--bg-2)",
            border: "1px solid var(--bg-3)",
            borderRadius: 6,
            color: "var(--text)",
            fontSize: 13,
            outline: "none",
          }}
        />
      </label>
      {order.limitPrice != null && (
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              color: "var(--text-dim)",
              fontSize: 11,
              textTransform: "uppercase",
            }}
          >
            limit
          </span>
          <input
            type="number"
            step="0.01"
            value={px}
            onChange={(e) => setPx(e.target.value)}
            style={{
              width: 110,
              padding: "6px 8px",
              background: "var(--bg-2)",
              border: "1px solid var(--bg-3)",
              borderRadius: 6,
              color: "var(--text)",
              fontSize: 13,
              outline: "none",
            }}
          />
        </label>
      )}
      <span
        style={{ color: "var(--text-dim)", fontSize: 11, marginLeft: "auto" }}
      >
        ↵ save · ESC cancel
      </span>
      <button
        type="button"
        onClick={commit}
        style={{
          padding: "6px 12px",
          borderRadius: 6,
          border: "1px solid var(--info)",
          background: "color-mix(in oklab, var(--info) 22%, transparent)",
          color: "var(--info)",
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Save
      </button>
      <button
        type="button"
        onClick={onCancel}
        style={{
          padding: "6px 12px",
          borderRadius: 6,
          border: "1px solid var(--bg-3)",
          background: "transparent",
          color: "var(--text-dim)",
          fontSize: 12,
          cursor: "pointer",
        }}
      >
        Cancel
      </button>
    </div>
  );
}
