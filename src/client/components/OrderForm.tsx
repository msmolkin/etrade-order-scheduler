/**
 * Slice 5.2 — Create Order rewrite (progressive disclosure).
 *
 * Brief §3.5: a sectioned vertical form. Conditional fields only appear
 * when their parent select unlocks them (option chain, threshold extras,
 * limit/stop prices). Schedule segmented control with a 5-cell preview
 * strip when Daily/Weekly is chosen. Sticky bottom summary that reads
 * back the order in plain English. Single in-place "Confirm? ↵ / ESC"
 * prompt for 3 s before firing (Brief §5.4).
 *
 * Threshold-monitor wiring is preserved — the same fields, the same POST
 * shape; only the chrome changes.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchOptionExpirations,
  fetchOptionsChain,
  fetchPositions,
  searchSymbols,
  type Order,
  type Position,
  type SymbolSearchResult,
} from "../utils/api";
import { useAccounts } from "../hooks/useAccounts";
import { useQuote } from "../hooks/useQuote";
import { useCreateOrder } from "../hooks/useCreateOrder";
import { useSubmitOrder } from "../hooks/useOrderMutations";

export type OrderFormDraft = Partial<{
  accountId: string;
  symbol: string;
  action: string;
  orderType: string;
  quantity: number;
  limitPrice: string;
  stopPrice: string;
  notes: string;
  securityType: "EQUITY" | "OPTION" | "MUTUAL_FUND" | "MONEY_MARKET_FUND";
  optionType: "CALL" | "PUT";
  strikePrice: number;
  expirationDate: string;
  preferredDuration: string;
  actualDuration: string;
  sessionTime: string;
  scheduleEnabled: boolean;
  scheduleFrequency: "DAILY" | "WEEKLY";
  scheduleOnce: boolean;
  scheduledFor: string;
  onlyFillOnce: boolean;
}>;

interface OrderFormProps {
  draft?: OrderFormDraft;
  onOrderCreated?: (draft: OrderFormDraft) => void;
}

type SecurityType = "EQUITY" | "OPTION" | "MUTUAL_FUND" | "MONEY_MARKET_FUND";
type Action = "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
type OrderType = "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT" | "THRESHOLD";
type Cadence = "ONCE" | "DAILY" | "WEEKLY" | "THRESHOLD";
type Session = "MARKET" | "EXTENDED";

interface FormState {
  accountId: string;
  symbol: string;
  securityType: SecurityType;
  optionType: "CALL" | "PUT";
  strikePrice: string;
  expirationDate: string;
  action: Action;
  orderType: OrderType;
  quantity: number | "";
  limitPrice: string;
  stopPrice: string;
  cadence: Cadence;
  scheduledFor: string;
  session: Session;
  thresholdPrice: string;
  thresholdPriceSource: "BID" | "ASK" | "LAST";
  thresholdQuantity: number;
  thresholdPollIntervalMs: number;
  thresholdLogFile: string;
  notes: string;
  onlyFillOnce: boolean;
}

const initial: FormState = {
  accountId: "",
  symbol: "",
  securityType: "EQUITY",
  optionType: "CALL",
  strikePrice: "",
  expirationDate: "",
  action: "BUY",
  orderType: "LIMIT",
  quantity: 1,
  limitPrice: "",
  stopPrice: "",
  cadence: "ONCE",
  scheduledFor: "",
  session: "EXTENDED",
  thresholdPrice: "",
  thresholdPriceSource: "BID",
  thresholdQuantity: 1,
  thresholdPollIntervalMs: 1000,
  thresholdLogFile: "",
  notes: "",
  onlyFillOnce: true,
};

/* ---------------- date helpers ---------------- */

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toLocalDateTimeInputValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

function normalizeIv(value: unknown): number | null {
  const iv = Number(value);
  if (!Number.isFinite(iv) || iv <= 0) return null;
  return iv > 3 ? iv / 100 : iv;
}

function yearsToOptionExpiration(expirationDate: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(expirationDate);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || !month || !day) return null;

  // Approximate listed option expiration at 4 PM ET as 20:00 UTC. Good enough
  // for a UI reference price; broker-side pricing remains authoritative.
  const expiryMs = Date.UTC(year, month - 1, day, 20, 0, 0, 0);
  const ms = expiryMs - Date.now();
  return Math.max(ms / (365 * 24 * 60 * 60_000), 1 / 365);
}

function blackScholesPrice(args: {
  optionType: "CALL" | "PUT";
  spot: number;
  strike: number;
  years: number;
  volatility: number;
  riskFreeRate: number;
}): number | null {
  const { optionType, spot, strike, years, volatility, riskFreeRate } = args;
  if (
    spot <= 0 ||
    strike <= 0 ||
    years <= 0 ||
    volatility <= 0 ||
    !Number.isFinite(spot + strike + years + volatility + riskFreeRate)
  ) {
    return null;
  }

  const sqrtT = Math.sqrt(years);
  const d1 =
    (Math.log(spot / strike) +
      (riskFreeRate + (volatility * volatility) / 2) * years) /
    (volatility * sqrtT);
  const d2 = d1 - volatility * sqrtT;
  const discountedStrike = strike * Math.exp(-riskFreeRate * years);

  if (optionType === "CALL") {
    return spot * normalCdf(d1) - discountedStrike * normalCdf(d2);
  }
  return discountedStrike * normalCdf(-d2) - spot * normalCdf(-d1);
}

/**
 * Build an ISO timestamp at the given hour:minute in ET on a calendar date.
 * Rough EST/EDT handling matches the QuickSend approach: we read the
 * shortOffset for that instant so DST flips are handled.
 */
function etInstantAt(date: Date, hour: number, minute: number): Date {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, p) => {
      if (p.type !== "literal") acc[p.type] = p.value;
      return acc;
    }, {});
  const year = parseInt(parts.year, 10);
  const month = parseInt(parts.month, 10);
  const day = parseInt(parts.day, 10);

  // Determine offset for *that* date by formatting a reference at noon ET.
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const tzFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset",
  });
  const tzPart =
    tzFmt.formatToParts(probe).find((p) => p.type === "timeZoneName")?.value ??
    "GMT-5";
  const m = tzPart.match(/GMT([+-])(\d{1,2})/);
  const sign = m && m[1] === "+" ? 1 : -1;
  const hours = m ? parseInt(m[2], 10) : 5;
  const offsetMs = sign * hours * 60 * 60_000;

  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0) - offsetMs);
}

function isWeekendET(d: Date): boolean {
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(d);
  return wd === "Sat" || wd === "Sun";
}

// NYSE full-closure holidays. Update annually around December.
// Source: tradingview/src/market/marketHours.ts (NYSE_FULL_CLOSURES).
// Weekend holidays: only observed if they shift to a weekday (Jul 4 Sat->Fri,
// Sun->Mon; Christmas same). Juneteenth on Sat (2027) is NOT observed.
const NYSE_HOLIDAYS: Set<string> = new Set([
  // 2025
  "2025-01-01",
  "2025-01-20",
  "2025-02-17",
  "2025-04-18",
  "2025-05-26",
  "2025-06-19",
  "2025-07-04",
  "2025-09-01",
  "2025-11-27",
  "2025-12-25",
  // 2026
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03",
  "2026-09-07",
  "2026-11-26",
  "2026-12-25",
  // 2027 — Juneteenth (Jun 19) falls on Saturday, NYSE does NOT observe
  "2027-01-01",
  "2027-01-18",
  "2027-02-15",
  "2027-03-26",
  "2027-05-31",
  "2027-07-05",
  "2027-09-06",
  "2027-11-25",
  "2027-12-24",
]);

// Early closes (1 PM ET regular, 5 PM ET after-hours).
// On these days, EXTENDED session orders after 5 PM ET will be rejected.
const NYSE_EARLY_CLOSE: Set<string> = new Set([
  "2025-07-03",
  "2025-11-28",
  "2025-12-24",
  "2026-11-27",
  "2026-12-24",
  "2027-11-26",
]);

function etDateStr(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function isMarketClosed(d: Date): boolean {
  return isWeekendET(d) || NYSE_HOLIDAYS.has(etDateStr(d));
}

function isEarlyClose(d: Date): boolean {
  return NYSE_EARLY_CLOSE.has(etDateStr(d));
}

function nextTradingDay(d: Date): Date {
  let next = new Date(d.getTime() + 24 * 60 * 60_000);
  while (isMarketClosed(next))
    next = new Date(next.getTime() + 24 * 60 * 60_000);
  return next;
}

function todayOrNextTradingDay(d: Date): Date {
  if (!isMarketClosed(d)) return d;
  let next = new Date(d.getTime() + 24 * 60 * 60_000);
  while (isMarketClosed(next))
    next = new Date(next.getTime() + 24 * 60 * 60_000);
  return next;
}

// Keep old names for backward compat in computeFires
function nextWeekday(d: Date): Date {
  return nextTradingDay(d);
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

function compactCadenceCell(d: Date): string {
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * Compute the next 5 fire timestamps based on cadence & session.
 * - Daily: starting tomorrow ET (skipping weekends), at 7:00 ET (extended)
 *   or 9:30 ET (market). 5 sequential trading days.
 * - Weekly: same hour, but 7 days apart (skip weekends if it lands on one).
 */
function computeFires(
  cadence: Cadence,
  session: Session,
  count: number = 5,
): Date[] {
  const hour = session === "EXTENDED" ? 7 : 9;
  const minute = session === "EXTENDED" ? 0 : 30;
  const fires: Date[] = [];

  let cursor = nextWeekday(new Date());
  let firstFire = etInstantAt(cursor, hour, minute);
  fires.push(firstFire);

  for (let i = 1; i < count; i++) {
    if (cadence === "WEEKLY") {
      cursor = new Date(cursor.getTime() + 7 * 24 * 60 * 60_000);
      while (isWeekendET(cursor)) {
        cursor = new Date(cursor.getTime() + 24 * 60 * 60_000);
      }
    } else {
      cursor = nextWeekday(cursor);
    }
    fires.push(etInstantAt(cursor, hour, minute));
  }
  return fires;
}

/* ---------------- component ---------------- */

export default function OrderForm({ draft, onOrderCreated }: OrderFormProps) {
  const [form, setForm] = useState<FormState>(initial);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [confirming, setConfirming] = useState<boolean>(false);
  const [confirmCountdown, setConfirmCountdown] = useState<number>(0);
  const confirmTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const placingRef = useRef(false);
  const [pmWarning, setPmWarning] = useState<{
    action: string;
    qty: number;
    symbol: string;
    price: number;
  } | null>(null);

  const accountsQuery = useAccounts();
  const accounts = accountsQuery.data?.accounts ?? [];
  const defaultAccountIdKey = accountsQuery.data?.defaultAccountIdKey ?? null;

  const quoteQuery = useQuote(form.symbol);
  const quote = quoteQuery.data ?? null;

  const createMut = useCreateOrder();
  const submitMut = useSubmitOrder();
  const placing = createMut.isPending || submitMut.isPending;

  /* Symbol search dropdown ----------------------------------------- */
  const symbolWrapRef = useRef<HTMLDivElement>(null);
  const symbolJustSelected = useRef(false);
  const [symbolResults, setSymbolResults] = useState<SymbolSearchResult[]>([]);
  const [symbolDropdownOpen, setSymbolDropdownOpen] = useState(false);
  const [symbolError, setSymbolError] = useState("");

  /* Option expirations --------------------------------------------- */
  const [optionExpirations, setOptionExpirations] = useState<string[]>([]);
  const [optionExpirationsError, setOptionExpirationsError] = useState("");
  const [optionQuote, setOptionQuote] = useState<{
    bid: number;
    ask: number;
    last: number;
    impliedVolatility?: number;
  } | null>(null);
  const [optionQuoteLoading, setOptionQuoteLoading] = useState(false);
  const [optionQuoteError, setOptionQuoteError] = useState("");
  const [heldQty, setHeldQty] = useState<number | null>(null);

  useEffect(() => {
    setHeldQty(null);
    if (!form.symbol || !form.accountId) return;
    if (form.action !== "SELL" && form.action !== "BUY_TO_COVER") return;
    fetchPositions(form.accountId).then((positions) => {
      const sym = form.symbol.toUpperCase();
      let matching;
      if (form.securityType === "OPTION") {
        // Match the specific option leg (symbol + type + strike + expiration).
        matching = positions.filter(
          (p) =>
            p.symbol.toUpperCase() === sym &&
            p.securityType === "OPTN" &&
            p.optionType === form.optionType &&
            p.strikePrice != null &&
            String(p.strikePrice) === form.strikePrice &&
            p.expirationDate === form.expirationDate,
        );
      } else {
        // Equity / other: match symbol + securityType "EQ", sum across lots.
        matching = positions.filter(
          (p) => p.symbol.toUpperCase() === sym && p.securityType === "EQ",
        );
      }
      const total = matching.reduce((sum, p) => sum + Math.abs(p.quantity), 0);
      setHeldQty(total);
    });
  }, [
    form.symbol,
    form.accountId,
    form.action,
    form.securityType,
    form.optionType,
    form.strikePrice,
    form.expirationDate,
  ]);

  /* Initial account select ----------------------------------------- */
  useEffect(() => {
    if (form.accountId || accounts.length === 0) return;
    const stored =
      typeof window !== "undefined"
        ? window.localStorage.getItem("selectedAccountIdKey")
        : null;
    const initialKey =
      stored && accounts.some((a) => a.accountIdKey === stored)
        ? stored
        : (defaultAccountIdKey ?? accounts[0]?.accountIdKey ?? "");
    if (initialKey) setForm((p) => ({ ...p, accountId: initialKey }));
  }, [accounts, defaultAccountIdKey, form.accountId]);

  /* Apply external draft prefill ----------------------------------- */
  useEffect(() => {
    if (!draft) return;
    setForm((prev) => ({
      ...prev,
      accountId: draft.accountId ?? prev.accountId,
      symbol: draft.symbol ?? prev.symbol,
      securityType:
        draft.securityType === "EQUITY" ||
        draft.securityType === "OPTION" ||
        draft.securityType === "MUTUAL_FUND" ||
        draft.securityType === "MONEY_MARKET_FUND"
          ? draft.securityType
          : prev.securityType,
      optionType: draft.optionType ?? prev.optionType,
      strikePrice:
        draft.strikePrice != null
          ? String(draft.strikePrice)
          : prev.strikePrice,
      expirationDate: draft.expirationDate ?? prev.expirationDate,
      action:
        draft.action === "BUY" ||
        draft.action === "SELL" ||
        draft.action === "BUY_TO_COVER" ||
        draft.action === "SELL_SHORT"
          ? draft.action
          : prev.action,
      orderType:
        draft.orderType === "MARKET" ||
        draft.orderType === "LIMIT" ||
        draft.orderType === "STOP" ||
        draft.orderType === "STOP_LIMIT" ||
        draft.orderType === "THRESHOLD"
          ? draft.orderType
          : prev.orderType,
      quantity: draft.quantity ?? prev.quantity,
      limitPrice: draft.limitPrice ?? prev.limitPrice,
      stopPrice: draft.stopPrice ?? prev.stopPrice,
      session:
        draft.sessionTime === "MARKET" || draft.sessionTime === "EXTENDED"
          ? draft.sessionTime
          : prev.session,
      cadence: draft.scheduleEnabled
        ? draft.scheduleFrequency === "WEEKLY"
          ? "WEEKLY"
          : draft.scheduleOnce
            ? "ONCE"
            : "DAILY"
        : prev.cadence,
      scheduledFor: draft.scheduledFor ?? prev.scheduledFor,
      notes: draft.notes ?? prev.notes,
      onlyFillOnce: draft.onlyFillOnce ?? prev.onlyFillOnce,
    }));
  }, [draft]);

  /* Symbol search effect ------------------------------------------- */
  useEffect(() => {
    const query = form.symbol.trim();
    if (!query || query.length < 2) {
      setSymbolResults([]);
      setSymbolDropdownOpen(false);
      setSymbolError("");
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const results = await searchSymbols(query);
        if (cancelled) return;
        setSymbolResults(results);
        if (!symbolJustSelected.current)
          setSymbolDropdownOpen(results.length > 0);
        symbolJustSelected.current = false;
      } catch (err: any) {
        if (cancelled) return;
        setSymbolResults([]);
        setSymbolDropdownOpen(false);
        setSymbolError(err?.message || "Failed to search symbols");
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [form.symbol]);

  /* Click outside symbol dropdown ---------------------------------- */
  useEffect(() => {
    if (!symbolDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        symbolWrapRef.current &&
        !symbolWrapRef.current.contains(e.target as Node)
      ) {
        setSymbolDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [symbolDropdownOpen]);

  /* Option expirations effect -------------------------------------- */
  useEffect(() => {
    const sym = form.symbol.trim();
    if (form.securityType !== "OPTION" || !sym) {
      setOptionExpirations([]);
      setOptionExpirationsError("");
      return;
    }
    let cancelled = false;
    fetchOptionExpirations(sym)
      .then((dates) => {
        if (cancelled) return;
        setOptionExpirations(dates);
        setOptionExpirationsError("");
      })
      .catch((err) => {
        if (cancelled) return;
        setOptionExpirations([]);
        setOptionExpirationsError(err?.message || "Failed to load expirations");
      });
    return () => {
      cancelled = true;
    };
  }, [form.symbol, form.securityType]);

  /* Selected option quote ----------------------------------------- */
  useEffect(() => {
    const sym = form.symbol.trim();
    const strike = Number(form.strikePrice);
    if (
      form.securityType !== "OPTION" ||
      !sym ||
      !form.expirationDate ||
      !Number.isFinite(strike) ||
      strike <= 0
    ) {
      setOptionQuote(null);
      setOptionQuoteLoading(false);
      setOptionQuoteError("");
      return;
    }

    let cancelled = false;
    setOptionQuoteLoading(true);
    setOptionQuoteError("");

    const t = setTimeout(async () => {
      try {
        const chain = await fetchOptionsChain(sym, form.expirationDate);
        if (cancelled) return;
        const legs = form.optionType === "CALL" ? chain?.calls : chain?.puts;
        const leg = Array.isArray(legs)
          ? legs.find(
              (candidate: any) =>
                Math.abs(Number(candidate?.strikePrice) - strike) < 0.001,
            )
          : null;
        const iv = normalizeIv(leg?.impliedVolatility);
        setOptionQuote(
          leg
            ? {
                bid: Number(leg.bid ?? 0),
                ask: Number(leg.ask ?? 0),
                last: Number(leg.last ?? 0),
                impliedVolatility: iv ?? undefined,
              }
            : null,
        );
        setOptionQuoteError(leg ? "" : "Option quote not found");
      } catch (err: any) {
        if (cancelled) return;
        setOptionQuote(null);
        setOptionQuoteError(err?.message || "Failed to load option quote");
      } finally {
        if (!cancelled) setOptionQuoteLoading(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [
    form.symbol,
    form.securityType,
    form.optionType,
    form.strikePrice,
    form.expirationDate,
  ]);

  /* Theoretical price — derived from chain IV + live spot, no refetch */
  const theoretical = useMemo(() => {
    if (!optionQuote?.impliedVolatility) return undefined;
    const strike = Number(form.strikePrice);
    const years = yearsToOptionExpiration(form.expirationDate);
    if (!Number.isFinite(strike) || strike <= 0 || years == null)
      return undefined;
    const spot = quote?.last ?? 0;
    if (spot <= 0) return undefined;
    const price = blackScholesPrice({
      optionType: form.optionType,
      spot,
      strike,
      years,
      volatility: optionQuote.impliedVolatility,
      riskFreeRate: 0.045,
    });
    return price ?? undefined;
  }, [
    optionQuote?.impliedVolatility,
    form.strikePrice,
    form.expirationDate,
    form.optionType,
    quote?.last,
  ]);

  /* Cleanup confirm timer ----------------------------------------- */
  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearInterval(confirmTimerRef.current);
    };
  }, []);

  /* ESC cancels pending confirmation ------------------------------ */
  useEffect(() => {
    if (!confirming) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelConfirm();
      } else if (e.key === "Enter") {
        e.preventDefault();
        void doPlace();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirming]);

  /* ---------------- derived ---------------- */

  const fires = useMemo(() => {
    if (form.cadence !== "DAILY" && form.cadence !== "WEEKLY") return [];
    return computeFires(form.cadence, form.session, 5);
  }, [form.cadence, form.session]);

  const summary = useMemo(
    () => buildSummary(form, quote, fires[0] ?? null),
    [form, quote, fires],
  );

  const valid = useMemo(() => {
    if (!form.accountId) return false;
    if (!form.symbol.trim()) return false;
    if (!form.quantity || Number(form.quantity) <= 0) return false;
    if (
      (form.orderType === "LIMIT" || form.orderType === "STOP_LIMIT") &&
      !form.limitPrice
    )
      return false;
    if (
      (form.orderType === "STOP" || form.orderType === "STOP_LIMIT") &&
      !form.stopPrice
    )
      return false;
    if (form.orderType === "THRESHOLD" && !form.thresholdPrice) return false;
    if (form.securityType === "OPTION") {
      if (!form.strikePrice || !form.expirationDate) return false;
    }
    return true;
  }, [form]);

  /* ---------------- handlers ---------------- */

  function handleSelectSymbol(r: SymbolSearchResult) {
    symbolJustSelected.current = true;
    setForm((prev) => ({ ...prev, symbol: r.symbol.toUpperCase() }));
    setSymbolResults([]);
    setSymbolDropdownOpen(false);
  }

  function buildPayload(): Partial<Order> & Record<string, unknown> {
    const isImmediate = form.cadence === "ONCE" && !form.scheduledFor;
    const scheduleEnabled =
      form.cadence === "DAILY" ||
      form.cadence === "WEEKLY" ||
      (form.cadence === "ONCE" && !!form.scheduledFor);
    const scheduleOnce = form.cadence === "ONCE";
    const scheduleFrequency: "DAILY" | "WEEKLY" | undefined =
      form.cadence === "DAILY"
        ? "DAILY"
        : form.cadence === "WEEKLY"
          ? "WEEKLY"
          : undefined;

    let scheduledFor: string | undefined;
    if (scheduleEnabled) {
      if (form.scheduledFor) {
        scheduledFor = new Date(form.scheduledFor).toISOString();
      } else if (fires[0]) {
        scheduledFor = fires[0].toISOString();
      }
    }

    return {
      accountId: form.accountId,
      symbol: form.symbol.trim().toUpperCase(),
      securityType: form.securityType,
      optionType: form.securityType === "OPTION" ? form.optionType : undefined,
      strikePrice:
        form.securityType === "OPTION" && form.strikePrice
          ? parseFloat(form.strikePrice)
          : undefined,
      expirationDate:
        form.securityType === "OPTION" && form.expirationDate
          ? form.expirationDate
          : undefined,
      action: form.action,
      orderType: form.orderType,
      quantity:
        typeof form.quantity === "number"
          ? form.quantity
          : parseInt(String(form.quantity), 10),
      limitPrice:
        form.orderType !== "MARKET" && form.limitPrice
          ? parseFloat(form.limitPrice)
          : undefined,
      stopPrice: form.stopPrice ? parseFloat(form.stopPrice) : undefined,
      preferredDuration: "DAY",
      actualDuration: "DAY",
      sessionTime: form.session,
      scheduleEnabled,
      scheduleFrequency,
      scheduleOnce,
      scheduledFor,
      onlyFillOnce: form.onlyFillOnce,
      requiresDaily: scheduleEnabled && form.cadence === "DAILY",
      status: isImmediate
        ? "PENDING"
        : scheduleEnabled
          ? "SCHEDULED"
          : "PENDING",
      retryCount: 0,
      maxRetries: 3,
      thresholdEnabled:
        form.cadence === "THRESHOLD" || form.orderType === "THRESHOLD",
      thresholdPrice: form.thresholdPrice
        ? parseFloat(form.thresholdPrice)
        : undefined,
      thresholdPriceSource: form.thresholdPriceSource,
      thresholdQuantity: form.thresholdQuantity,
      thresholdPollIntervalMs: form.thresholdPollIntervalMs,
      thresholdLogFile: form.thresholdLogFile || undefined,
      notes: form.notes || undefined,
    };
  }

  function buildDraftForHistory(): OrderFormDraft {
    return {
      accountId: form.accountId,
      symbol: form.symbol,
      securityType: form.securityType,
      optionType: form.optionType,
      strikePrice: form.strikePrice ? parseFloat(form.strikePrice) : undefined,
      expirationDate: form.expirationDate || undefined,
      action: form.action,
      orderType: form.orderType,
      quantity:
        typeof form.quantity === "number"
          ? form.quantity
          : parseInt(String(form.quantity), 10),
      limitPrice: form.limitPrice || undefined,
      stopPrice: form.stopPrice || undefined,
      preferredDuration: "DAY",
      actualDuration: "DAY",
      sessionTime: form.session,
      scheduleEnabled:
        form.cadence === "DAILY" ||
        form.cadence === "WEEKLY" ||
        (form.cadence === "ONCE" && !!form.scheduledFor),
      scheduleFrequency:
        form.cadence === "DAILY"
          ? "DAILY"
          : form.cadence === "WEEKLY"
            ? "WEEKLY"
            : undefined,
      scheduleOnce: form.cadence === "ONCE",
      scheduledFor: form.scheduledFor || undefined,
      notes: form.notes || undefined,
      onlyFillOnce: form.onlyFillOnce,
    };
  }

  function startConfirm() {
    if (!valid || placing) return;
    setError("");
    setSuccess("");
    setConfirming(true);
    setConfirmCountdown(3);
    if (confirmTimerRef.current) clearInterval(confirmTimerRef.current);
    confirmTimerRef.current = setInterval(() => {
      setConfirmCountdown((c) => {
        if (c <= 1) {
          if (confirmTimerRef.current) clearInterval(confirmTimerRef.current);
          void doPlace();
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  }

  function cancelConfirm() {
    if (confirmTimerRef.current) clearInterval(confirmTimerRef.current);
    setConfirming(false);
    setConfirmCountdown(0);
  }

  async function doPlace() {
    if (confirmTimerRef.current) clearInterval(confirmTimerRef.current);
    setConfirming(false);
    setConfirmCountdown(0);
    if (!valid || placing || placingRef.current) return;
    placingRef.current = true;
    try {
      const payload = buildPayload();
      let isImmediate = form.cadence === "ONCE" && !form.scheduledFor;
      let autoScheduled = false;

      // E*TRADE rejects EXTENDED orders outside 7 AM - 8 PM ET.
      if (isImmediate && form.session === "EXTENDED") {
        const etHour = parseInt(
          new Intl.DateTimeFormat("en-US", {
            timeZone: "America/New_York",
            hour: "numeric",
            hour12: false,
          }).format(new Date()),
          10,
        );
        if (etHour >= 20 || etHour < 7) {
          const base =
            etHour >= 20
              ? nextTradingDay(new Date())
              : todayOrNextTradingDay(new Date());
          const nextFire = etInstantAt(base, 7, 0);
          payload.scheduledFor = nextFire.toISOString();
          payload.scheduleEnabled = true;
          payload.scheduleOnce = true;
          isImmediate = false;
          autoScheduled = true;
        }
      }

      // E*TRADE rejects market orders ~4:00-4:05 PM ET (post-close transition)
      if (isImmediate && form.orderType === "MARKET") {
        const now = new Date();
        const etParts = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          hour: "numeric",
          minute: "numeric",
          hour12: false,
        }).formatToParts(now);
        const h = parseInt(
          etParts.find((p) => p.type === "hour")?.value ?? "0",
          10,
        );
        const m = parseInt(
          etParts.find((p) => p.type === "minute")?.value ?? "0",
          10,
        );
        if (h === 16 && m < 5) {
          const price = quote?.last ?? quote?.ask ?? quote?.bid ?? 0;
          setPmWarning({
            action: form.action,
            qty: parseInt(form.quantity, 10) || 0,
            symbol: form.symbol,
            price,
          });
          placingRef.current = false;
          return;
        }
      }

      const created = await createMut.mutateAsync(payload as any);
      onOrderCreated?.(buildDraftForHistory());

      const shouldSendNow = isImmediate ||
        (form.cadence === "DAILY" || form.cadence === "WEEKLY");

      if (shouldSendNow && !autoScheduled) {
        const result = await submitMut.mutateAsync(created.id);
        if (!result.success) {
          throw new Error(result.order?.lastError || "Order submission failed");
        }
        const eid = result.order.etradeOrderId ?? "pending";
        const recurLabel = !isImmediate
          ? ` (+ scheduled ${(form.cadence ?? "").toLowerCase()})`
          : "";
        setSuccess(`Sent: E*TRADE id ${eid}${recurLabel}`);
      } else if (autoScheduled && payload.scheduledFor) {
        setSuccess(
          `Scheduled for ${formatHumanET(new Date(payload.scheduledFor))} ET (extended hours closed)`,
        );
      } else if (payload.scheduledFor) {
        setSuccess(
          `Scheduled for ${formatHumanET(new Date(payload.scheduledFor))} ET`,
        );
      } else {
        setSuccess("Order created.");
      }
      // Reset preserving account.
      setForm({ ...initial, accountId: form.accountId });
    } catch (err: any) {
      setError(err?.message ?? "Failed to create order");
    } finally {
      placingRef.current = false;
    }
  }

  async function placeAsExtended() {
    setPmWarning(null);
    const price = pmWarning?.price ?? quote?.last ?? quote?.ask ?? 0;
    if (!price) {
      setError("No price available for limit order");
      return;
    }
    setForm((p) => ({
      ...p,
      sessionTime: "EXTENDED" as any,
      orderType: "LIMIT" as any,
      limitPrice: price.toFixed(2),
    }));
    setSuccess(
      "Converted to EXTENDED LIMIT @ $" +
        price.toFixed(2) +
        " \u2014 tap Place Order to send.",
    );
  }

  async function placeForTomorrow() {
    setPmWarning(null);
    placingRef.current = true;
    try {
      const payload = buildPayload();
      const nextDay = nextTradingDay(new Date());
      const fireAt = etInstantAt(nextDay, 9, 30);
      payload.scheduledFor = fireAt.toISOString();
      payload.scheduleEnabled = true;
      payload.scheduleOnce = true;
      const created = await createMut.mutateAsync(payload as any);
      onOrderCreated?.(buildDraftForHistory());
      setSuccess(`Scheduled for ${formatHumanET(fireAt)} ET`);
      setForm({ ...initial, accountId: form.accountId });
    } catch (err: any) {
      setError(err?.message ?? "Failed to schedule order");
    } finally {
      placingRef.current = false;
    }
  }

  const optionSpreadLine =
    form.securityType === "OPTION" && form.symbol.trim() ? (
      <div
        id="order-option-spread"
        style={{
          marginTop: 6,
          fontSize: 11,
          fontFamily:
            "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
          color: "var(--text-dim)",
          minHeight: 16,
        }}
      >
        {form.expirationDate && form.strikePrice ? (
          optionQuoteLoading ? (
            <span>option spread: loading...</span>
          ) : optionQuote ? (
            <>
              <span>
                {form.optionType} {form.strikePrice} {form.expirationDate}
              </span>
              <Sep />
              bid{" "}
              <NumColored
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (optionQuote.bid > 0)
                    setForm((p) => ({
                      ...p,
                      limitPrice: optionQuote.bid.toFixed(2),
                      orderType:
                        p.orderType === "MARKET" ? "LIMIT" : p.orderType,
                    }));
                }}
                style={{
                  cursor: optionQuote.bid > 0 ? "pointer" : "default",
                  textDecoration: optionQuote.bid > 0 ? "underline" : "none",
                }}
              >
                {optionQuote.bid > 0 ? `$${optionQuote.bid.toFixed(2)}` : "-"}
              </NumColored>
              <Sep />
              ask{" "}
              <NumColored
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (optionQuote.ask > 0)
                    setForm((p) => ({
                      ...p,
                      limitPrice: optionQuote.ask.toFixed(2),
                      orderType:
                        p.orderType === "MARKET" ? "LIMIT" : p.orderType,
                    }));
                }}
                style={{
                  cursor: optionQuote.ask > 0 ? "pointer" : "default",
                  textDecoration: optionQuote.ask > 0 ? "underline" : "none",
                }}
              >
                {optionQuote.ask > 0 ? `$${optionQuote.ask.toFixed(2)}` : "-"}
              </NumColored>
              {optionQuote.bid > 0 && optionQuote.ask > 0 && (
                <>
                  <Sep />
                  spread ${(optionQuote.ask - optionQuote.bid).toFixed(2)}
                </>
              )}
              <Sep />
              theo {theoretical != null ? `$${theoretical.toFixed(2)}` : "-"}
              {optionQuote.impliedVolatility != null && (
                <>
                  {" "}
                  <span style={{ color: "var(--text-dim)" }}>
                    IV {(optionQuote.impliedVolatility * 100).toFixed(1)}%
                  </span>
                </>
              )}
            </>
          ) : (
            <span>{optionQuoteError || "option spread unavailable"}</span>
          )
        ) : (
          <span>select strike and expiration for option spread</span>
        )}
      </div>
    ) : null;

  const setAtmStrike = async () => {
    if (!form.symbol.trim() || !quote || !quote.last) return;
    const sym = form.symbol.trim().toUpperCase();
    const exp = form.expirationDate || undefined;
    try {
      const chain = await fetchOptionsChain(sym, exp);
      const legs = form.optionType === "CALL" ? chain?.calls : chain?.puts;
      if (!Array.isArray(legs) || legs.length === 0) return;
      const spot = quote.last;
      const liquid = legs.filter(
        (l: any) => (l.openInterest ?? 0) >= 10 || (l.volume ?? 0) >= 5,
      );
      const pool = liquid.length > 0 ? liquid : legs;
      let best = pool[0];
      let bestDist = Math.abs(Number(best.strikePrice) - spot);
      for (const l of pool) {
        const d = Math.abs(Number(l.strikePrice) - spot);
        if (d < bestDist) { best = l; bestDist = d; }
      }
      setForm((p) => ({ ...p, strikePrice: String(best.strikePrice) }));
    } catch {}
  };

  /* ---------------- render ---------------- */

  return (
    <div
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "0 12px 120px",
        position: "relative",
      }}
    >
      <h2
        style={{
          color: "var(--text)",
          fontSize: 18,
          fontWeight: 600,
          margin: "0 0 14px",
        }}
      >
        Create Order
      </h2>

      {error && <Banner kind="error">{error}</Banner>}
      {success && <Banner kind="ok">{success}</Banner>}

      <div
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--bg-3)",
          borderRadius: 12,
          padding: 18,
          display: "flex",
          flexDirection: "column",
          gap: 22,
        }}
      >
        {/* Account ------------------------------------------------ */}
        {accounts.length > 1 ? (
          <Field label="Account" htmlFor="order-account">
            <select
              id="order-account"
              value={form.accountId}
              onChange={(e) => {
                const v = e.target.value;
                setForm((p) => ({ ...p, accountId: v }));
                if (typeof window !== "undefined")
                  window.localStorage.setItem("selectedAccountIdKey", v);
              }}
              style={selectStyle}
            >
              <option value="" disabled>
                Select account
              </option>
              {accounts.map((a) => (
                <option key={a.accountIdKey} value={a.accountIdKey}>
                  {a.nickname} — {a.name || "Unnamed"} ({a.type})
                </option>
              ))}
            </select>
          </Field>
        ) : null}

        {/* Symbol ------------------------------------------------- */}
        <Field label="Symbol" htmlFor="order-symbol">
          <div ref={symbolWrapRef} style={{ position: "relative" }}>
            <input
              id="order-symbol"
              autoFocus
              type="text"
              value={form.symbol}
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) =>
                setForm((p) => ({ ...p, symbol: e.target.value.toUpperCase() }))
              }
              placeholder="AMD"
              style={{ ...inputStyle, fontWeight: 600 }}
            />
            {symbolDropdownOpen && symbolResults.length > 0 && (
              <div
                style={{
                  position: "absolute",
                  inset: "calc(100% + 4px) 0 auto 0",
                  zIndex: 20,
                  maxHeight: 200,
                  overflow: "auto",
                  background: "var(--bg-2)",
                  border: "1px solid var(--bg-3)",
                  borderRadius: 8,
                  boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
                }}
              >
                {symbolResults.map((r) => (
                  <button
                    key={`${r.symbol}-${r.exchange}-${r.securityType}`}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handleSelectSymbol(r);
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "8px 12px",
                      background: "transparent",
                      border: 0,
                      cursor: "pointer",
                      color: "var(--text)",
                      fontSize: 13,
                    }}
                  >
                    <strong>{r.symbol}</strong>
                    {r.companyName ? (
                      <span style={{ color: "var(--text-dim)" }}>
                        {" "}
                        — {r.companyName}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            )}
            {symbolError && (
              <div
                style={{ marginTop: 6, color: "var(--accent)", fontSize: 11 }}
              >
                {symbolError}
              </div>
            )}
          </div>

          {/* Live quote line */}
          <div
            style={{
              marginTop: 8,
              fontSize: 12,
              fontFamily:
                "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
              color: "var(--text-dim)",
              minHeight: 18,
            }}
          >
            {form.symbol.trim() && quote ? (
              <>
                <strong style={{ color: "var(--text)" }}>
                  {form.symbol.trim().toUpperCase()}
                </strong>
                <Sep />
                bid{" "}
                <NumColored
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (quote.bid > 0)
                      setForm((p) => ({
                        ...p,
                        limitPrice: quote.bid.toFixed(2),
                        orderType:
                          p.orderType === "MARKET" ? "LIMIT" : p.orderType,
                      }));
                  }}
                  style={{
                    cursor: quote.bid > 0 ? "pointer" : "default",
                    textDecoration: quote.bid > 0 ? "underline" : "none",
                  }}
                >
                  {quote.bid > 0 ? `$${quote.bid.toFixed(2)}` : "—"}
                </NumColored>
                <Sep />
                ask{" "}
                <NumColored
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (quote.ask > 0)
                      setForm((p) => ({
                        ...p,
                        limitPrice: quote.ask.toFixed(2),
                        orderType:
                          p.orderType === "MARKET" ? "LIMIT" : p.orderType,
                      }));
                  }}
                  style={{
                    cursor: quote.ask > 0 ? "pointer" : "default",
                    textDecoration: quote.ask > 0 ? "underline" : "none",
                  }}
                >
                  {quote.ask > 0 ? `$${quote.ask.toFixed(2)}` : "—"}
                </NumColored>
                <Sep />
                last{" "}
                <NumColored>
                  {quote.last > 0 ? `$${quote.last.toFixed(2)}` : "—"}
                </NumColored>
                <Sep />
                <span>
                  session:{" "}
                  {form.session === "EXTENDED" ? "extended" : "regular"}
                </span>
              </>
            ) : form.symbol.trim() ? (
              <span>fetching quote…</span>
            ) : (
              <span>type a symbol to see the live quote</span>
            )}
          </div>
        </Field>

        {/* Security type ----------------------------------------- */}
        <Field label="Security type" htmlFor="order-security-type">
          <select
            id="order-security-type"
            value={form.securityType}
            onChange={(e) =>
              setForm((p) => ({
                ...p,
                securityType: e.target.value as SecurityType,
              }))
            }
            style={selectStyle}
          >
            <option value="EQUITY">Equity</option>
            <option value="OPTION">Option</option>
            <option value="MUTUAL_FUND">Mutual fund</option>
            <option value="MONEY_MARKET_FUND">Money market fund</option>
          </select>
        </Field>

        {form.securityType === "OPTION" && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "80px 1fr 1fr",
              gap: 12,
            }}
          >
            <Field label="C / P" htmlFor="order-option-type">
              <div style={{ display: "flex", gap: 0, background: "var(--bg-2)", border: "1px solid var(--bg-3)", borderRadius: 8, padding: 2 }}>
                {(["CALL", "PUT"] as const).map((v) => {
                  const active = form.optionType === v;
                  return (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setForm((p) => ({ ...p, optionType: v }))}
                      style={{
                        flex: 1,
                        padding: "8px 2px",
                        fontSize: 11,
                        fontWeight: active ? 700 : 500,
                        border: 0,
                        borderRadius: 6,
                        cursor: "pointer",
                        background: active ? "color-mix(in oklab, var(--info) 22%, transparent)" : "transparent",
                        color: active ? "var(--info)" : "var(--text-dim)",
                      }}
                    >
                      {v === "CALL" ? "C" : "P"}
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label="Strike" htmlFor="order-strike">
              <div style={{ display: "flex", gap: 4 }}>
                <input
                  id="order-strike"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  value={form.strikePrice}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, strikePrice: e.target.value }))
                  }
                  style={{ ...inputStyle, flex: 1, minWidth: 0 }}
                  placeholder="100"
                />
                <button
                  type="button"
                  onClick={setAtmStrike}
                  disabled={!form.symbol.trim() || !quote}
                  title="Set strike to nearest ATM with liquidity"
                  style={{
                    padding: "8px 8px",
                    borderRadius: 8,
                    border: "1px solid var(--bg-3)",
                    background: "var(--bg-2)",
                    color: !form.symbol.trim() || !quote ? "var(--text-dim)" : "var(--info)",
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: !form.symbol.trim() || !quote ? "not-allowed" : "pointer",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  ATM
                </button>
              </div>
            </Field>
            <Field label="Expiration" htmlFor="order-expiration">
              {optionExpirations.length > 0 ? (
                <select
                  id="order-expiration"
                  value={form.expirationDate}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, expirationDate: e.target.value }))
                  }
                  style={selectStyle}
                >
                  <option value="">Select…</option>
                  {optionExpirations.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="order-expiration"
                  type="date"
                  value={form.expirationDate}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, expirationDate: e.target.value }))
                  }
                  style={inputStyle}
                />
              )}
              {optionExpirationsError && (
                <div
                  style={{ marginTop: 6, color: "var(--accent)", fontSize: 11 }}
                >
                  {optionExpirationsError}
                </div>
              )}
            </Field>
          </div>
        )}

        {/* Action ------------------------------------------------- */}
        <Field label="Action">
          <Segmented
            ariaLabel="Action"
            options={[
              { value: "BUY", label: "BUY" },
              { value: "SELL", label: "SELL" },
              { value: "SELL_SHORT", label: "SHORT" },
              { value: "BUY_TO_COVER", label: "COVER" },
            ]}
            value={form.action}
            onChange={(v) => setForm((p) => ({ ...p, action: v as Action }))}
            colorize={(v) =>
              v === "BUY" || v === "BUY_TO_COVER" ? "var(--ok)" : "var(--bad)"
            }
          />
        </Field>

        {/* Order type -------------------------------------------- */}
        <Field label="Order type" htmlFor="order-type">
          <div style={{ display: "flex", gap: 0, background: "var(--bg-2)", border: "1px solid var(--bg-3)", borderRadius: 8, padding: 3 }}>
            {([["MARKET", "MARKET"], ["LIMIT", "LIMIT"], ["STOP", "STOP"], ["STOP_LIMIT", "STOP LMT"], ["THRESHOLD", "THRESH"]] as const).map(([val, label]) => {
              const active = form.orderType === val;
              return (
                <button
                  key={val}
                  type="button"
                  onClick={() => setForm((p) => ({ ...p, orderType: val as OrderType }))}
                  style={{
                    flex: 1,
                    padding: "8px 4px",
                    fontSize: 11,
                    fontWeight: active ? 700 : 500,
                    border: 0,
                    borderRadius: 6,
                    cursor: "pointer",
                    transition: "background 0.15s",
                    background: active ? "color-mix(in oklab, var(--info) 22%, transparent)" : "transparent",
                    color: active ? "var(--info)" : "var(--text-dim)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </Field>

        {(form.orderType === "LIMIT" || form.orderType === "STOP_LIMIT") && (
          <Field label="Limit price" htmlFor="order-limit-price">
            <input
              id="order-limit-price"
              type="number"
              inputMode="decimal"
              step="0.01"
              value={form.limitPrice}
              onChange={(e) =>
                setForm((p) => ({ ...p, limitPrice: e.target.value }))
              }
              style={inputStyle}
              aria-describedby={
                optionSpreadLine ? "order-option-spread" : undefined
              }
            />
            {optionSpreadLine}
          </Field>
        )}

        {(form.orderType === "STOP" || form.orderType === "STOP_LIMIT") && (
          <Field label="Stop price" htmlFor="order-stop-price">
            <input
              id="order-stop-price"
              type="number"
              inputMode="decimal"
              step="0.01"
              value={form.stopPrice}
              onChange={(e) =>
                setForm((p) => ({ ...p, stopPrice: e.target.value }))
              }
              style={inputStyle}
            />
          </Field>
        )}

        {form.orderType === "THRESHOLD" && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 12,
            }}
          >
            <Field label="Threshold price" htmlFor="order-threshold-price">
              <input
                id="order-threshold-price"
                type="number"
                inputMode="decimal"
                step="0.01"
                value={form.thresholdPrice}
                onChange={(e) =>
                  setForm((p) => ({ ...p, thresholdPrice: e.target.value }))
                }
                style={inputStyle}
              />
            </Field>
            <Field label="Threshold qty" htmlFor="order-threshold-quantity">
              <input
                id="order-threshold-quantity"
                type="number"
                inputMode="numeric"
                min={1}
                value={form.thresholdQuantity}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    thresholdQuantity: parseInt(e.target.value) || 1,
                  }))
                }
                style={inputStyle}
              />
            </Field>
            <Field label="Price source" htmlFor="order-threshold-price-source">
              <select
                id="order-threshold-price-source"
                value={form.thresholdPriceSource}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    thresholdPriceSource: e.target.value as
                      | "BID"
                      | "ASK"
                      | "LAST",
                  }))
                }
                style={selectStyle}
              >
                <option value="BID">BID</option>
                <option value="ASK">ASK</option>
                <option value="LAST">LAST</option>
              </select>
            </Field>
          </div>
        )}

        {/* Quantity ---------------------------------------------- */}
        <Field label="Quantity" htmlFor="order-quantity">
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              id="order-quantity"
              type="number"
              inputMode="numeric"
              min={1}
              value={form.quantity}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === "") setForm((p) => ({ ...p, quantity: "" as any }));
                else {
                  const n = parseInt(raw, 10);
                  if (!Number.isNaN(n))
                    setForm((p) => ({ ...p, quantity: Math.max(1, n) }));
                }
              }}
              onBlur={() => {
                if (!form.quantity) setForm((p) => ({ ...p, quantity: 1 }));
              }}
              style={{ ...inputStyle, flex: 1, minWidth: 0 }}
            />
            {[10, 50, 100].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setForm((p) => ({ ...p, quantity: n }))}
                style={{
                  padding: "6px 8px",
                  borderRadius: 6,
                  border: form.quantity === n ? "1px solid var(--info)" : "1px solid var(--bg-3)",
                  background: form.quantity === n ? "color-mix(in oklab, var(--info) 18%, transparent)" : "var(--bg-2)",
                  color: form.quantity === n ? "var(--info)" : "var(--text-dim)",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                {n}
              </button>
            ))}
            {(form.action === "SELL" || form.action === "BUY_TO_COVER") &&
              heldQty !== null &&
              heldQty > 0 && (
                <button
                  type="button"
                  onClick={() => setForm((p) => ({ ...p, quantity: heldQty }))}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 6,
                    border: "1px solid var(--bg-3)",
                    background:
                      form.quantity === heldQty ? "var(--bg-3)" : "var(--bg-2)",
                    color: "var(--text)",
                    fontSize: 12,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {form.action === "BUY_TO_COVER" ? "Cover" : "Sell"} all (
                  {heldQty} held)
                </button>
              )}
          </div>
        </Field>

        {/* Schedule ---------------------------------------------- */}
        <Field label="Schedule">
          <Segmented
            ariaLabel="Schedule"
            options={[
              { value: "ONCE", label: "Once" },
              { value: "DAILY", label: "Daily" },
              { value: "WEEKLY", label: "Weekly" },
              { value: "THRESHOLD", label: "Threshold-driven" },
            ]}
            value={form.cadence}
            onChange={(v) => setForm((p) => ({ ...p, cadence: v as Cadence }))}
          />
        </Field>

        {/* Cadence preview strip --------------------------------- */}
        {(form.cadence === "DAILY" || form.cadence === "WEEKLY") &&
          fires.length > 0 && (
            <div>
              <div
                style={{
                  color: "var(--text-dim)",
                  fontSize: 11,
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                  marginBottom: 6,
                }}
              >
                Next 5 fires
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(5, 1fr)",
                  gap: 6,
                }}
              >
                {fires.map((f, i) => (
                  <div
                    key={i}
                    style={{
                      background:
                        i === 0
                          ? "color-mix(in oklab, var(--accent) 20%, transparent)"
                          : "var(--bg-2)",
                      border: "1px solid var(--bg-3)",
                      borderRadius: 8,
                      padding: "8px 6px",
                      textAlign: "center",
                      fontFamily:
                        "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
                      fontSize: 11,
                      color: i === 0 ? "var(--accent)" : "var(--text-dim)",
                      lineHeight: 1.35,
                    }}
                  >
                    {compactCadenceCell(f)} ET
                  </div>
                ))}
              </div>
            </div>
          )}

        {form.cadence === "ONCE" && (
          <Field label="Schedule time (optional)" htmlFor="order-scheduled-for">
            <div style={{ position: "relative" }}>
              <input
                id="order-scheduled-for"
                type="datetime-local"
                value={form.scheduledFor}
                onChange={(e) =>
                  setForm((p) => ({ ...p, scheduledFor: e.target.value }))
                }
                min={toLocalDateTimeInputValue(new Date())}
                style={{
                  ...inputStyle,
                  colorScheme: "dark",
                }}
              />
              {!form.scheduledFor && (
                <div
                  className="mobile-only"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    display: "flex",
                    alignItems: "center",
                    padding: "10px 12px",
                    color: "var(--text-dim)",
                    fontSize: 14,
                    pointerEvents: "none",
                  }}
                >
                  Tap to pick date &amp; time
                </div>
              )}
            </div>
            <div
              style={{ marginTop: 6, color: "var(--text-dim)", fontSize: 11 }}
            >
              {form.scheduledFor
                ? `Fires ${formatHumanET(new Date(form.scheduledFor))} ET`
                : "Leave blank to send right away."}
            </div>
          </Field>
        )}

        {/* Only fill once ---------------------------------------- */}
        {(form.cadence === "DAILY" || form.cadence === "WEEKLY") && (
          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              cursor: "pointer",
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid var(--bg-3)",
              background: "var(--bg-2)",
            }}
          >
            <input
              id="order-only-fill-once"
              type="checkbox"
              checked={form.onlyFillOnce}
              onChange={(e) =>
                setForm((p) => ({ ...p, onlyFillOnce: e.target.checked }))
              }
              style={{ marginTop: 2 }}
            />
            <span style={{ fontSize: 13, color: "var(--text)" }}>
              Only fill once
              <span
                style={{
                  display: "block",
                  marginTop: 2,
                  fontSize: 11,
                  color: "var(--text-dim)",
                }}
              >
                Cancel future scheduled clones once this order actually fills at
                E*TRADE. Partial fills shrink the next clone to the unfilled
                remainder.
              </span>
            </span>
          </label>
        )}

        {/* Session ----------------------------------------------- */}
        <Field label="Session" htmlFor="order-session">
          <select
            id="order-session"
            value={form.session}
            onChange={(e) =>
              setForm((p) => ({ ...p, session: e.target.value as Session }))
            }
            style={selectStyle}
          >
            <option value="MARKET">MARKET (9:30 ET)</option>
            <option value="EXTENDED">EXTENDED (7:00 ET)</option>
          </select>
        </Field>

        {/* Notes ------------------------------------------------- */}
        <Field label="Notes (optional)" htmlFor="order-notes">
          <textarea
            id="order-notes"
            rows={2}
            value={form.notes}
            onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
            style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical" }}
          />
        </Field>
      </div>

      {/* Sticky bottom summary -------------------------------------- */}
      <div
        style={{
          position: "sticky",
          bottom: 0,
          marginTop: 16,
          background: "var(--bg-2)",
          border: "1px solid var(--bg-3)",
          borderRadius: 12,
          padding: "14px 18px",
          display: "flex",
          gap: 12,
          alignItems: "center",
          boxShadow: "0 -8px 24px rgba(0,0,0,0.35)",
        }}
      >
        <div
          style={{
            flex: 1,
            color: "var(--text)",
            fontSize: 13,
            lineHeight: 1.45,
          }}
        >
          {summary ? (
            <HighlightAction text={summary} action={form.action} />
          ) : (
            <span style={{ color: "var(--text-dim)" }}>
              Fill in symbol, action, quantity, and price to see the order
              summary.
            </span>
          )}
        </div>
        {pmWarning ? (
          <div
            style={{
              padding: "12px 16px",
              borderRadius: 8,
              background: "rgba(251,191,36,0.1)",
              border: "1px solid rgba(251,191,36,0.3)",
              fontSize: 13,
              color: "#fbbf24",
              marginBottom: 8,
            }}
          >
            <div style={{ marginBottom: 8 }}>
              E*TRADE rejects orders during the post-close transition
              (4:00\u20134:05 PM ET). Your order:{" "}
              <b style={{ color: "#fff" }}>
                {pmWarning.action} {pmWarning.qty} {pmWarning.symbol} @{" "}
                {pmWarning.price > 0
                  ? "$" + pmWarning.price.toFixed(2)
                  : "market"}
              </b>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={placeAsExtended}
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  borderRadius: 6,
                  border: "1px solid #3b82f6",
                  background: "rgba(59,130,246,0.15)",
                  color: "#60a5fa",
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                Place EH Order
              </button>
              <button
                type="button"
                onClick={placeForTomorrow}
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  borderRadius: 6,
                  border: "1px solid #334155",
                  background: "rgba(30,41,59,0.5)",
                  color: "#cbd5e1",
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                Place tomorrow
              </button>
            </div>
            <button
              type="button"
              onClick={() => setPmWarning(null)}
              style={{
                marginTop: 6,
                background: "transparent",
                border: 0,
                color: "#64748b",
                fontSize: 11,
                cursor: "pointer",
                padding: 0,
              }}
            >
              Cancel
            </button>
          </div>
        ) : confirming ? (
          <button
            type="button"
            onClick={cancelConfirm}
            style={{
              padding: "10px 18px",
              border: `1px solid var(--accent)`,
              borderRadius: 10,
              background: "color-mix(in oklab, var(--accent) 22%, transparent)",
              color: "var(--accent)",
              fontWeight: 700,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Confirm? ↵ / ESC ({confirmCountdown}s)
          </button>
        ) : (
          <button
            type="button"
            onClick={startConfirm}
            disabled={!valid || placing}
            style={{
              padding: "10px 18px",
              borderRadius: 10,
              border: 0,
              fontWeight: 700,
              fontSize: 13,
              cursor: !valid || placing ? "not-allowed" : "pointer",
              background:
                !valid || placing
                  ? "var(--bg-3)"
                  : form.action === "BUY" || form.action === "BUY_TO_COVER"
                    ? "color-mix(in oklab, var(--ok) 75%, black)"
                    : "color-mix(in oklab, var(--bad) 75%, black)",
              color: !valid || placing ? "var(--text-dim)" : "var(--text)",
            }}
          >
            {placing ? "Placing…" : "Place order →"}
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------------- helpers ---------------- */

function buildSummary(
  form: FormState,
  quote: { bid: number; ask: number; last: number } | null,
  firstFire: Date | null,
): string {
  const sym = form.symbol.trim().toUpperCase() || "—";
  const qty = form.quantity || 0;
  const action = form.action.replace(/_/g, " ");
  const orderType = form.orderType;

  const px =
    form.orderType === "LIMIT" || form.orderType === "STOP_LIMIT"
      ? form.limitPrice
      : form.orderType === "STOP"
        ? form.stopPrice
        : form.orderType === "THRESHOLD"
          ? form.thresholdPrice
          : "";
  const priceLabel = px ? ` at ${orderType} $${px}` : ` at ${orderType}`;

  const cadenceLabel =
    form.cadence === "ONCE"
      ? "once"
      : form.cadence === "DAILY"
        ? "daily"
        : form.cadence === "WEEKLY"
          ? "weekly"
          : "threshold-driven";

  const sessionLabel = `${form.session === "MARKET" ? "9:30" : "7:00"} ET ${form.session}`;

  // Estimate notional from limit price when present, otherwise from quote.
  let estPx: number | null = null;
  if (px && !Number.isNaN(parseFloat(px))) estPx = parseFloat(px);
  else if (quote) {
    estPx =
      form.action === "BUY" || form.action === "BUY_TO_COVER"
        ? quote.ask
        : quote.bid;
    if (!estPx) estPx = quote.last;
  }
  const estCost =
    estPx && qty
      ? `$${(qty * estPx).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
      : null;

  let firstFireLabel = "";
  if (form.cadence === "DAILY" || form.cadence === "WEEKLY") {
    firstFireLabel = firstFire
      ? ` · first fire ${formatHumanET(firstFire)} ET`
      : "";
  } else if (form.cadence === "ONCE" && form.scheduledFor) {
    const d = new Date(form.scheduledFor);
    if (!Number.isNaN(d.getTime()))
      firstFireLabel = ` · fires ${formatHumanET(d)} ET`;
  }

  return `You are about to schedule ${action} ${qty} ${sym}${priceLabel} ${cadenceLabel} · ${sessionLabel}${
    estCost ? ` · est max cost ${estCost}` : ""
  }${firstFireLabel}.`;
}

/* ---------------- styled bits ---------------- */

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  background: "var(--bg-2)",
  border: "1px solid var(--bg-3)",
  borderRadius: 8,
  color: "var(--text)",
  fontSize: 14,
  outline: "none",
};

const selectStyle: React.CSSProperties = { ...inputStyle, appearance: "none" };

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
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
        marginBottom: 12,
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

function Sep() {
  return <span style={{ margin: "0 8px", color: "var(--bg-3)" }}>·</span>;
}

function NumColored({ children }: { children: React.ReactNode }) {
  return <span style={{ color: "var(--text)" }}>{children}</span>;
}

interface SegmentedProps<T extends string> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  colorize?: (v: T) => string;
  ariaLabel?: string;
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  colorize,
  ariaLabel,
}: SegmentedProps<T>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
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
            aria-pressed={active}
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

function HighlightAction({ text, action }: { text: string; action: string }) {
  const label = action.replace(/_/g, " ");
  const idx = text.indexOf(label);
  if (idx < 0) return <>{text}</>;
  const isBuy = action === "BUY" || action === "BUY_TO_COVER";
  return (
    <>
      {text.slice(0, idx)}
      <span style={{
        color: "#fff",
        background: isBuy ? "var(--ok)" : "var(--bad)",
        padding: "1px 6px",
        borderRadius: 3,
        fontWeight: 600,
      }}>
        {label}
      </span>
      {text.slice(idx + label.length)}
    </>
  );
}
