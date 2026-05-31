/**
 * Slice 5.1 — Quick Send rewrite.
 *
 * Brief §3.4: a single screen, no modal stack. Two-column CSS grid.
 *   Left column: form (symbol, qty, order type, side, "Fire when").
 *   Right column: live confirm card (side · qty · symbol · type · session ·
 *                  bid/ask · est cost · margin used) + big Place order button.
 *
 * One confirmation only — the card itself is the confirmation. Enter submits
 * (when valid), ESC clears the form. We do not auto-submit on focus changes.
 *
 * The underlying API still does preview-then-submit (createOrder ->
 * submitOrder) for "Now"; for scheduled fires we just create with
 * scheduleEnabled=true and a calculated scheduledFor timestamp.
 */
import React, { useState, useEffect, useRef, useMemo } from "react";
import { useAccounts } from "../hooks/useAccounts";
import { useQuote, type Quote } from "../hooks/useQuote";
import { useCreateOrder } from "../hooks/useCreateOrder";
import { useSubmitOrder } from "../hooks/useOrderMutations";
import {
  type OrderHistoryItem,
  type OrderHistoryDraft,
} from "../utils/orderHistory";

type Side = "BUY" | "SELL" | "SELL_SHORT" | "BUY_TO_COVER";
type OrderType = "MARKET" | "LIMIT" | "STOP";
type FireWhen = "now" | "in2" | "open" | "custom";
type PriceMode = "auto" | "bid" | "ask" | "last";

interface QuickSendProps {
  orderHistory: OrderHistoryItem[];
  onOrderSent?: (draft: OrderHistoryDraft) => void;
}

const SIDE_OPTIONS: { value: Side; label: string }[] = [
  { value: "BUY", label: "BUY" },
  { value: "SELL", label: "SELL" },
  { value: "SELL_SHORT", label: "SHORT" },
  { value: "BUY_TO_COVER", label: "COVER" },
];

const FIRE_OPTIONS: { value: FireWhen; label: string }[] = [
  { value: "now", label: "Now" },
  { value: "in2", label: "In 2 min" },
  { value: "open", label: "Market open (9:30)" },
  { value: "custom", label: "Custom..." },
];

/* ------------------------------------------------------------------ */
/* Time helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Next "Market open" 9:30 ET. If now is before 9:30 ET on a weekday, return
 * today; otherwise return the next weekday's 9:30 ET.
 */
function nextMarketOpenET(now: Date = new Date()): Date {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => {
      if (p.type !== "literal") acc[p.type] = p.value;
      return acc;
    }, {});
  const year = parseInt(parts.year, 10);
  const month = parseInt(parts.month, 10);
  const day = parseInt(parts.day, 10);
  const hh = parseInt(parts.hour, 10);
  const mm = parseInt(parts.minute, 10);

  const targetMinutes = 9 * 60 + 30;
  const nowETMinutes = hh * 60 + mm;

  // Construct UTC instant equal to today 09:30 ET.
  const offsetMs = guessETOffsetMs(now);
  const todayOpen = new Date(
    Date.UTC(year, month - 1, day, 9, 30, 0) - offsetMs,
  );

  const isWeekend = (d: Date): boolean => {
    const wd = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
    }).format(d);
    return wd === "Sat" || wd === "Sun";
  };

  let target = todayOpen;
  if (nowETMinutes >= targetMinutes || isWeekend(target)) {
    do {
      target = new Date(target.getTime() + 24 * 60 * 60_000);
    } while (isWeekend(target));
  }
  return target;
}

/**
 * Approximate the ET offset (EST = -300, EDT = -240) by reading the formatter
 * shortOffset, e.g. "GMT-5". Off by a few hours during the DST transition
 * window which is fine for the UI label; server confirms exact time.
 */
function guessETOffsetMs(now: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset",
  });
  const tz =
    fmt.formatToParts(now).find((p) => p.type === "timeZoneName")?.value ??
    "GMT-5";
  const m = tz.match(/GMT([+-])(\d{1,2})/);
  if (!m) return -5 * 60 * 60_000;
  const sign = m[1] === "+" ? 1 : -1;
  const hours = parseInt(m[2], 10);
  return sign * hours * 60 * 60_000;
}

function plusMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function formatScheduledForISO(d: Date): string {
  return d.toISOString();
}

function formatHumanET(d: Date): string {
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function toLocalDateTimeInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */

export default function QuickSend({
  orderHistory: _orderHistory,
  onOrderSent,
}: QuickSendProps) {
  const [symbol, setSymbol] = useState("");
  const [quantity, setQuantity] = useState<number | "">(100);
  const [orderType, setOrderType] = useState<OrderType>("LIMIT");
  const [stopPrice, setStopPrice] = useState<string>("");
  const [side, setSide] = useState<Side>("BUY");
  const [fireWhen, setFireWhen] = useState<FireWhen>("now");
  const [customFire, setCustomFire] = useState<string>("");
  const [accountId, setAccountId] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [priceMode, setPriceMode] = useState<PriceMode>("auto");

  const symbolInputRef = useRef<HTMLInputElement>(null);
  const lastLimitPrice = useRef<number | null>(null);
  const [lastOrderId, setLastOrderId] = useState<string | null>(null);
  const [lastEtradeId, setLastEtradeId] = useState<string | null>(null);
  const isNarrow = useMediaQuery("(max-width: 720px)");

  /* Accounts ------------------------------------------------------- */
  const accountsQuery = useAccounts();
  const accounts = accountsQuery.data?.accounts ?? [];
  const defaultAccountIdKey = accountsQuery.data?.defaultAccountIdKey ?? null;

  useEffect(() => {
    if (accountId || accounts.length === 0) return;
    const stored =
      typeof window !== "undefined"
        ? window.localStorage.getItem("selectedAccountIdKey")
        : null;
    const initial =
      stored && accounts.some((a) => a.accountIdKey === stored)
        ? stored
        : (defaultAccountIdKey ?? accounts[0]?.accountIdKey ?? "");
    if (initial) setAccountId(initial);
  }, [accounts, accountId, defaultAccountIdKey]);

  /* Quote --------------------------------------------------------- */
  const quoteQuery = useQuote(symbol, true);
  const quote: Quote | null = quoteQuery.data ?? null;

  /* Mutations ----------------------------------------------------- */
  const createMut = useCreateOrder();
  const submitMut = useSubmitOrder();
  const placing = createMut.isPending || submitMut.isPending;

  /* Derived ------------------------------------------------------- */
  const limitPrice = useMemo(() => {
    if (!quote) return null;
    if (priceMode === "bid") return quote.bid || null;
    if (priceMode === "ask") return quote.ask || null;
    if (priceMode === "last") return quote.last || null;
    if (side === "BUY" || side === "BUY_TO_COVER")
      return quote.ask || quote.last;
    return quote.bid || quote.last;
  }, [quote, side, priceMode]);

  const estCost = useMemo(() => {
    if (!quantity || !quote) return null;
    const px =
      orderType === "MARKET"
        ? side === "BUY" || side === "BUY_TO_COVER"
          ? quote.ask
          : quote.bid
        : (limitPrice ?? quote.last);
    if (!px) return null;
    return Number(quantity) * px;
  }, [quantity, quote, orderType, side, limitPrice]);

  const marginUsed = useMemo(() => {
    if (estCost == null) return null;
    const ratio = side === "SELL_SHORT" ? 0.5 : 1.0;
    return estCost * ratio;
  }, [estCost, side]);

  const fireDate: Date | null = useMemo(() => {
    if (fireWhen === "now") return null;
    if (fireWhen === "in2") return plusMinutes(new Date(), 2);
    if (fireWhen === "open") return nextMarketOpenET();
    if (fireWhen === "custom" && customFire) {
      const d = new Date(customFire);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
  }, [fireWhen, customFire]);

  const sessionLabel = useMemo(() => {
    if (fireWhen === "open") return "MARKET";
    return "EXTENDED";
  }, [fireWhen]);

  const isReady =
    !!accountId &&
    !!symbol.trim() &&
    !!quantity &&
    Number(quantity) > 0 &&
    (orderType === "MARKET" || (orderType === "STOP" && stopPrice && Number(stopPrice) > 0) || (orderType === "LIMIT" && limitPrice != null && limitPrice > 0)) &&
    (fireWhen !== "custom" || !!fireDate);

  /* Handlers ------------------------------------------------------ */
  // Previously reset qty to 100, side to BUY, and order type to LIMIT.
  // Now keeps symbol, side, and quantity so repeated orders are faster.
  const reset = (keepSymbol = true) => {
    if (!keepSymbol) setSymbol("");
    setOrderType("LIMIT");
    setStopPrice("");
    setFireWhen("now");
    setCustomFire("");
    setPriceMode("auto");
    setError("");
  };

  const handlePriceModeClick = (mode: "bid" | "ask" | "last") => {
    if (orderType === "MARKET") setOrderType("LIMIT");
    setPriceMode((prev) => {
      if (prev === mode) { quoteQuery.refetch(); return "auto"; }
      return mode;
    });
  };

  const pollOrderStatus = (orderId: string, etradeId: string) => {
    const API = import.meta.env.VITE_API_URL || "/api";
    let attempts = 0;
    const maxAttempts = 10;
    const iv = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch(`${API}/orders/${orderId}/verify`, {
          method: "POST",
        });
        if (!res.ok) {
          clearInterval(iv);
          return;
        }
        const order = await res.json();
        const st = order.status;
        if (st === "SUBMITTED") {
          const pxInfo = order.limitPrice ? `Limit $${Number(order.limitPrice).toFixed(2)}` : order.orderType ?? "Market";
          setSuccess(`E*TRADE id ${etradeId}\nOPEN ${pxInfo}\naccepted, awaiting fill`);
          clearInterval(iv);
        } else if (st === "FILLED" || st === "PARTIALLY_FILLED") {
          const qty = order.filledQuantity ?? order.quantity;
          const px = order.filledPrice ?? order.limitPrice ?? lastLimitPrice.current;
          const comm = order.commission;
          const pxStr = px ? `@ $${Number(px).toFixed(2)}` : "";
          const commStr = comm ? ` + $${Number(comm).toFixed(2)} comm` : "";
          setSuccess(`E*TRADE id ${etradeId}\nFILLED ${qty} shares ${pxStr}${commStr}`);
          setLastOrderId(null);
          setLastEtradeId(null);
          clearInterval(iv);
        } else if (st === "REJECTED") {
          setError(
            `E*TRADE id ${etradeId}\nREJECTED\n${order.lastError ?? "unknown reason"}`,
          );
          setLastOrderId(null);
          setSuccess("");
          clearInterval(iv);
        } else if (st === "CANCELLED" || st === "EXPIRED") {
          setSuccess(`E*TRADE id ${etradeId}\n${st}`);
          setLastOrderId(null);
          setLastEtradeId(null);
          clearInterval(iv);
        } else if (attempts >= maxAttempts) {
          const spInfo = order.limitPrice ? `Limit $${Number(order.limitPrice).toFixed(2)}` : order.orderType ?? "Market";
          setSuccess(
            `E*TRADE id ${etradeId}\n${st} ${spInfo}\nstopped auto-checking`,
          );
          clearInterval(iv);
        }
      } catch {
        clearInterval(iv);
      }
    }, 2000);
  };

  const handlePlace = async () => {
    if (!isReady || placing) return;
    setError("");
    setSuccess("");

    const sym = symbol.trim().toUpperCase();
    const qty = Number(quantity);
    const px =
      orderType === "LIMIT" && limitPrice
        ? Number(limitPrice.toFixed(2))
        : undefined;
    const sp =
      orderType === "STOP" && stopPrice
        ? Number(Number(stopPrice).toFixed(2))
        : undefined;

    const isImmediate = fireWhen === "now";
    const payload: Record<string, unknown> = {
      accountId,
      symbol: sym,
      securityType: "EQUITY",
      action: side,
      orderType,
      quantity: qty,
      limitPrice: px,
      stopPrice: sp,
      actualDuration: "DAY",
      preferredDuration: "DAY",
      sessionTime: sessionLabel,
      scheduleEnabled: !isImmediate,
      scheduleOnce: !isImmediate,
      scheduledFor:
        !isImmediate && fireDate ? formatScheduledForISO(fireDate) : undefined,
      status: isImmediate ? "PENDING" : "PAUSED",
      retryCount: 0,
      maxRetries: 3,
      onlyFillOnce: true,
    };

    try {
      const created = await createMut.mutateAsync(payload as any);
      if (isImmediate) {
        const result = await submitMut.mutateAsync(created.id);
        if (!result.success) {
          throw new Error(result.order?.lastError || "Order submission failed");
        }
        const eid = result.order.etradeOrderId ?? "pending";
        lastLimitPrice.current = px ?? null;
        setLastOrderId(created.id);
        setLastEtradeId(eid);
        const pxLabel = px ? `Limit $${px.toFixed(2)}` : sp ? `Stop $${sp.toFixed(2)}` : "Market";
        setSuccess(`E*TRADE id ${eid}\n${pxLabel}\nchecking status…`);
        pollOrderStatus(created.id, eid);
      } else {
        setSuccess(
          `Saved paused for ${fireDate ? formatHumanET(fireDate) : "later"} ET`,
        );
      }
      onOrderSent?.({
        accountId,
        symbol: sym,
        securityType: "EQUITY",
        action: side,
        orderType,
        quantity: qty,
        limitPrice: px != null ? px.toFixed(2) : undefined,
        sessionTime: sessionLabel,
        scheduleEnabled: !isImmediate,
        scheduleOnce: !isImmediate,
        onlyFillOnce: true,
      });
      reset(true);
    } catch (err: any) {
      setError(err?.message ?? "Failed to place order");
    }
  };

  /* Keyboard: Enter submits, ESC clears. Only when focus is in our subtree. */
  const handleFormKeyDown: React.KeyboardEventHandler<HTMLDivElement> = (e) => {
    const tag = (e.target as HTMLElement).tagName;
    if (e.key === "Enter") {
      if (tag === "TEXTAREA") return;
      e.preventDefault();
      void handlePlace();
    } else if (e.key === "Escape") {
      e.preventDefault();
      reset(false);
      symbolInputRef.current?.focus();
    }
  };

  /* Render -------------------------------------------------------- */
  return (
    <div
      onKeyDown={handleFormKeyDown}
      style={{
        display: "grid",
        gridTemplateColumns: isNarrow
          ? "minmax(0, 1fr)"
          : "minmax(0, 1fr) minmax(320px, 420px)",
        gap: isNarrow ? 16 : 24,
        maxWidth: 980,
        margin: "0 auto",
        padding: "0 12px",
      }}
    >
      {/* ── LEFT: form ────────────────────────────────────────────── */}
      <div
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--bg-3)",
          borderRadius: 12,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 18,
          order: isNarrow ? 2 : 1,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
          }}
        >
          <h2
            style={{
              color: "var(--text)",
              fontSize: 18,
              fontWeight: 600,
              margin: 0,
            }}
          >
            Quick Send
          </h2>
          <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
            ↵ to place · ESC to clear
          </span>
        </div>

        {accounts.length > 1 && (
          <Field label="Account">
            <select
              value={accountId}
              onChange={(e) => {
                const v = e.target.value;
                setAccountId(v);
                if (typeof window !== "undefined") {
                  window.localStorage.setItem("selectedAccountIdKey", v);
                }
              }}
              style={selectStyle}
            >
              {accounts.map((a) => (
                <option key={a.accountIdKey} value={a.accountIdKey}>
                  {a.nickname} — {a.name || "Unnamed"} ({a.type})
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field label="Symbol">
          <input
            ref={symbolInputRef}
            type="text"
            value={symbol}
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => {
              setSymbol(e.target.value.toUpperCase());
              setError("");
              setSuccess("");
            }}
            placeholder="AAPL"
            autoFocus
            style={{
              ...inputStyle,
              fontSize: 22,
              fontWeight: 700,
              letterSpacing: "0.04em",
              textAlign: "center",
            }}
          />
        </Field>

        <Field label="Quantity">
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              value={quantity}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === "") setQuantity("");
                else setQuantity(Math.max(1, parseInt(raw, 10) || 1));
              }}
              style={{ ...inputStyle, flex: 1, minWidth: 0 }}
            />
            {[10, 50, 100].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setQuantity(n)}
                style={{
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: quantity === n ? "1px solid var(--info)" : "1px solid var(--bg-3)",
                  background: quantity === n ? "color-mix(in oklab, var(--info) 18%, transparent)" : "var(--bg-2)",
                  color: quantity === n ? "var(--info)" : "var(--text-dim)",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                {n}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Order type">
          <div style={{ display: "flex", gap: 0, background: "var(--bg-2)", border: "1px solid var(--bg-3)", borderRadius: 8, padding: 3 }}>
            {(["LIMIT", "MARKET", "STOP"] as const).map((v) => {
              const active = orderType === v;
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => setOrderType(v)}
                  style={{
                    flex: 1,
                    padding: "8px 10px",
                    fontSize: 12,
                    fontWeight: active ? 700 : 500,
                    border: 0,
                    borderRadius: 6,
                    cursor: "pointer",
                    transition: "background 0.15s",
                    background: active ? "color-mix(in oklab, var(--info) 22%, transparent)" : "transparent",
                    color: active ? "var(--info)" : "var(--text-dim)",
                  }}
                >
                  {v}
                </button>
              );
            })}
          </div>
        </Field>

        <Field label="Action">
          <Segmented
            options={SIDE_OPTIONS}
            value={side}
            onChange={(v) => setSide(v as Side)}
            colorize={(v) =>
              v === "BUY" || v === "BUY_TO_COVER" ? "var(--ok)" : "var(--bad)"
            }
          />
        </Field>

        <Field label="Fire when">
          <Segmented
            options={FIRE_OPTIONS}
            value={fireWhen}
            onChange={(v) => setFireWhen(v as FireWhen)}
          />
        </Field>

        {fireWhen === "custom" && (
          <Field label="Custom time">
            <input
              type="datetime-local"
              value={customFire}
              onChange={(e) => setCustomFire(e.target.value)}
              min={toLocalDateTimeInputValue(new Date())}
              style={inputStyle}
            />
          </Field>
        )}

        {error && <Banner kind="error">{error}</Banner>}
        {success && (
          <Banner kind="ok">
            <div>{success}</div>
            {lastOrderId && (<div style={{ marginTop: 6, display: "flex", gap: 6 }}>
              <button
                type="button"
                onClick={async () => {
                  try {
                    const API = import.meta.env.VITE_API_URL || "/api";
                    if (lastEtradeId && lastEtradeId !== "pending") {
                      const cancelRes = await fetch(`${API}/orders/broker/${lastEtradeId}/cancel`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ accountIdKey: accountId }),
                      });
                      if (!cancelRes.ok) {
                        const err = await cancelRes.json().catch(() => ({}));
                        throw new Error(err.error ?? `Cancel failed (${cancelRes.status})`);
                      }
                      const verifyRes = await fetch(`${API}/orders/${lastOrderId}/verify`, { method: "POST" });
                      if (verifyRes.ok) {
                        const verified = await verifyRes.json();
                        if (verified.status === "FILLED" || verified.status === "PARTIALLY_FILLED") {
                          setSuccess(`Order already filled before cancel (${verified.filledQuantity ?? "?"} shares)`);
                          setLastOrderId(null);
                          setLastEtradeId(null);
                          return;
                        }
                      }
                    }
                    await fetch(`${API}/orders/${lastOrderId}`, { method: "DELETE" });
                    setSuccess("Order cancelled.");
                    setLastOrderId(null);
                    setLastEtradeId(null);
                  } catch (err: any) {
                    setError(err?.message ?? "Failed to cancel order");
                  }
                }}
                style={{
                  padding: "3px 10px",
                  borderRadius: 4,
                  border: "1px solid var(--bad)",
                  background: "transparent",
                  color: "var(--bad)",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  try {
                    const API = import.meta.env.VITE_API_URL || "/api";
                    const res = await fetch(`${API}/orders/${lastOrderId}/verify`, { method: "POST" });
                    if (!res.ok) throw new Error("Verify failed");
                    const order = await res.json();
                    const st = order.status;
                    const eid = lastEtradeId ?? "?";
                    if (st === "FILLED" || st === "PARTIALLY_FILLED") {
                      const qty = order.filledQuantity ?? order.quantity;
                      const px = order.filledPrice ?? order.limitPrice ?? lastLimitPrice.current;
                      const comm = order.commission;
                      const cpx = px ? `@ $${Number(px).toFixed(2)}` : "";
                      const ccomm = comm ? ` + $${Number(comm).toFixed(2)} comm` : "";
                      setSuccess(`E*TRADE id ${eid}\nFILLED ${qty} shares ${cpx}${ccomm}`);
                      setLastOrderId(null);
                      setLastEtradeId(null);
                    } else if (st === "CANCELLED" || st === "EXPIRED" || st === "REJECTED") {
                      setSuccess(`E*TRADE id ${eid}\n${st}${order.lastError ? "\n" + order.lastError : ""}`);
                      setLastOrderId(null);
                      setLastEtradeId(null);
                    } else {
                      const chkInfo = order.limitPrice ? `Limit $${Number(order.limitPrice).toFixed(2)}` : order.orderType ?? "Market";
                      setSuccess(`E*TRADE id ${eid}\n${st} ${chkInfo}`);
                    }
                  } catch {
                    setError("Failed to check status");
                  }
                }}
                style={{
                  padding: "3px 10px",
                  borderRadius: 4,
                  border: "1px solid var(--info)",
                  background: "transparent",
                  color: "var(--info)",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Check
              </button>
            </div>)}
          </Banner>
        )}
      </div>

      {/* ── RIGHT: confirm card ──────────────────────────────────── */}
      <div
        style={{
          background: "var(--bg-2)",
          border: "1px solid var(--bg-3)",
          borderRadius: 12,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          alignSelf: "start",
          position: isNarrow ? "static" : "sticky",
          top: 16,
          order: isNarrow ? 1 : 2,
        }}
      >
        <div
          style={{
            color: "var(--text-dim)",
            fontSize: 11,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          Confirm
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <div
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: "var(--text)",
              lineHeight: 1.2,
              flex: 1,
            }}
          >
            <span
              role="button"
              tabIndex={0}
              onClick={() => setSide((s) => s === "BUY" ? "SELL" : s === "SELL" ? "BUY" : s === "BUY_TO_COVER" ? "SELL_SHORT" : "BUY_TO_COVER")}
              style={{
                color: "#fff",
                background:
                  side === "BUY" || side === "BUY_TO_COVER"
                    ? "var(--ok)"
                    : "var(--bad)",
                padding: "2px 8px",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              {SIDE_OPTIONS.find((o) => o.value === side)?.label ?? side}
            </span>
            <span style={{ color: "var(--text-dim)", fontWeight: 500 }}>
              {" "}
              {quantity || 0}{" "}
            </span>
            <span>{symbol.trim().toUpperCase() || "—"}</span>
            <span style={{ color: "var(--text-dim)", fontWeight: 500 }}>
              {" "}
              {orderType}
            </span>
          </div>
          <button
            type="button"
            onClick={() => quoteQuery.refetch()}
            disabled={!symbol.trim() || quoteQuery.isFetching}
            title="Refresh quote"
            style={{
              padding: "4px 8px",
              borderRadius: 6,
              border: "1px solid var(--bg-3)",
              background: "transparent",
              color: quoteQuery.isFetching ? "var(--text-dim)" : "var(--info)",
              fontSize: 14,
              cursor: !symbol.trim() || quoteQuery.isFetching ? "not-allowed" : "pointer",
              flexShrink: 0,
            }}
          >
            {quoteQuery.isFetching ? "↻" : "↻"}
          </button>
        </div>

        <Row label="Session" value={sessionLabel} />
        <Row
          label="Fires"
          value={
            fireWhen === "now"
              ? "immediately"
              : fireDate
                ? formatHumanET(fireDate) + " ET"
                : "—"
          }
        />

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 6,
            padding: "10px 12px",
            background: "var(--bg-1)",
            borderRadius: 8,
            fontFamily:
              "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
            fontSize: 12,
          }}
        >
          <QuoteCell
            label="bid"
            value={quote?.bid}
            active={priceMode === "bid"}
            onClick={() => handlePriceModeClick("bid")}
          />
          <QuoteCell
            label="ask"
            value={quote?.ask}
            active={priceMode === "ask"}
            onClick={() => handlePriceModeClick("ask")}
          />
          <QuoteCell
            label="last"
            value={quote?.last}
            active={priceMode === "last"}
            onClick={() => handlePriceModeClick("last")}
          />
        </div>

        {orderType === "STOP" && (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ color: "var(--text-dim)", fontSize: 13, flexShrink: 0 }}>Stop $</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              value={stopPrice}
              onChange={(e) => setStopPrice(e.target.value)}
              placeholder="0.00"
              style={{
                flex: 1,
                padding: "8px 10px",
                background: "var(--bg-1)",
                border: "1px solid var(--bg-3)",
                borderRadius: 6,
                color: "var(--text)",
                fontSize: 14,
                fontWeight: 600,
                outline: "none",
                minWidth: 0,
              }}
            />
          </div>
        )}
        <Row
          label="Est. cost"
          value={
            estCost != null
              ? `$${estCost.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
              : "—"
          }
        />
        <Row
          label="Margin used"
          value={
            marginUsed != null
              ? `$${marginUsed.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
              : "—"
          }
        />
        {orderType === "LIMIT" && (
          <Row
            label="Limit price"
            value={limitPrice != null ? `$${limitPrice.toFixed(2)}` : "—"}
          />
        )}

        <button
          type="button"
          onClick={() => void handlePlace()}
          disabled={!isReady || placing}
          style={{
            marginTop: 6,
            padding: "14px 18px",
            borderRadius: 10,
            fontSize: 15,
            fontWeight: 700,
            border: 0,
            cursor: !isReady || placing ? "not-allowed" : "pointer",
            background:
              !isReady || placing
                ? "var(--bg-3)"
                : side === "BUY" || side === "BUY_TO_COVER"
                  ? "color-mix(in oklab, var(--ok) 75%, black)"
                  : "color-mix(in oklab, var(--bad) 75%, black)",
            color: !isReady || placing ? "var(--text-dim)" : "var(--text)",
            transition: "background 0.15s",
          }}
        >
          {placing ? "Placing..." : "Place order →"}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Subcomponents                                                      */
/* ------------------------------------------------------------------ */

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  background: "var(--bg-2)",
  border: "1px solid var(--bg-3)",
  borderRadius: 8,
  color: "var(--text)",
  fontSize: 14,
  outline: "none",
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  appearance: "none",
};

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        style={{
          display: "block",
          color: "var(--text-dim)",
          fontSize: 11,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}
    >
      <span style={{ color: "var(--text-dim)" }}>{label}</span>
      <span
        style={{ color: "var(--text)", fontVariantNumeric: "tabular-nums" }}
      >
        {value}
      </span>
    </div>
  );
}

function QuoteCell({
  label,
  value,
  active,
  onClick,
}: {
  label: string;
  value: number | undefined;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        textAlign: "center",
        background: active
          ? "color-mix(in oklab, var(--info) 22%, transparent)"
          : "transparent",
        border: active ? "1px solid var(--info)" : "1px solid transparent",
        borderRadius: 6,
        padding: "4px 2px",
        cursor: onClick ? "pointer" : "default",
        color: "inherit",
        fontFamily: "inherit",
        fontSize: "inherit",
        transition: "background 0.15s, border-color 0.15s",
      }}
    >
      <div
        style={{
          color: active ? "var(--info)" : "var(--text-dim)",
          fontSize: 10,
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div style={{ color: "var(--text)", fontSize: 13 }}>
        {value != null && value > 0 ? `$${value.toFixed(2)}` : "—"}
      </div>
    </button>
  );
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    setMatches(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

function Banner({
  kind,
  children,
}: {
  kind: "error" | "ok";
  children: React.ReactNode;
}) {
  const fg = kind === "error" ? "var(--bad)" : "var(--ok)";
  return (
    <div
      style={{
        padding: "8px 12px",
        borderRadius: 8,
        border: `1px solid ${fg}`,
        background: `color-mix(in oklab, ${fg} 12%, transparent)`,
        color: fg,
        fontSize: 12,
        whiteSpace: "pre-wrap",
      }}
    >
      {children}
    </div>
  );
}

interface SegmentedProps<T extends string> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  colorize?: (v: T) => string;
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  colorize,
}: SegmentedProps<T>) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${options.length}, 1fr)`,
        gap: 0,
        background: "var(--bg-2)",
        border: "1px solid var(--bg-3)",
        borderRadius: 8,
        padding: 3,
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        const c = colorize ? colorize(opt.value) : "var(--info)";
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            style={{
              padding: "8px 10px",
              fontSize: 12,
              fontWeight: active ? 700 : 500,
              border: 0,
              borderRadius: 6,
              cursor: "pointer",
              transition: "background 0.15s",
              background: active
                ? `color-mix(in oklab, ${c} 22%, transparent)`
                : "transparent",
              color: active ? c : "var(--text-dim)",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
