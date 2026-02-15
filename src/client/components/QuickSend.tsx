import React, { useState, useEffect, useRef } from 'react';
import {
  createOrder,
  fetchAccounts,
  fetchQuote,
  submitOrder,
  type TradingAccount,
} from '../utils/api';
import {
  getHistoryItemLabel,
  type OrderHistoryItem,
  type OrderHistoryDraft,
} from '../utils/orderHistory';

/**
 * Default maximum notional value (in USD) used to auto-calculate the order
 * quantity.  Adjust this to match your account size / risk tolerance.
 */
const DEFAULT_MAX_NOTIONAL = 50000;

interface QuickSendProps {
  orderHistory: OrderHistoryItem[];
  onOrderSent?: (draft: OrderHistoryDraft) => void;
}

type SessionMode = 'HIDDEN' | 'EXTENDED' | 'NONE';

interface QuoteData {
  bid: number;
  ask: number;
  last: number;
}

export default function QuickSend({ orderHistory, onOrderSent }: QuickSendProps) {
  /* ── Form state ─────────────────────────────────────────────── */
  const [ticker, setTicker] = useState('');
  const [action, setAction] = useState<'BUY' | 'SELL' | null>(null);
  const [priceType, setPriceType] = useState<'BID' | 'ASK' | null>(null);
  const [session, setSession] = useState<SessionMode>('EXTENDED');
  const [quantity, setQuantity] = useState<number | ''>(100);
  const [accountId, setAccountId] = useState('');

  /* ── Quote ──────────────────────────────────────────────────── */
  const [quote, setQuote] = useState<QuoteData | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState('');

  /* ── Accounts ───────────────────────────────────────────────── */
  const [accounts, setAccounts] = useState<TradingAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState('');

  /* ── Submission ─────────────────────────────────────────────── */
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  /* ── History menu ───────────────────────────────────────────── */
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const historyMenuRef = useRef<HTMLDivElement>(null);

  /* ── Track whether the user manually edited qty ─────────────── */
  const [qtyManuallySet, setQtyManuallySet] = useState(false);

  /* ── Track whether the user changed bid/ask manually ─────────── */
  const [priceTypeManuallySet, setPriceTypeManuallySet] = useState<boolean>(false);

  /* ================================================================
   * Load accounts on mount
   * ============================================================= */
  useEffect(() => {
    const load = async () => {
      try {
        setAccountsLoading(true);
        setAccountsError('');
        const storedKey =
          typeof window !== 'undefined'
            ? window.localStorage.getItem('selectedAccountIdKey')
            : null;
        const { accounts: fetched, defaultAccountIdKey } = await fetchAccounts();
        setAccounts(fetched);
        const initial =
          storedKey && fetched.some((a) => a.accountIdKey === storedKey)
            ? storedKey
            : defaultAccountIdKey;
        if (initial) setAccountId(initial);
      } catch (err: any) {
        setAccountsError(err.message || 'Failed to load accounts');
      } finally {
        setAccountsLoading(false);
      }
    };
    load();
  }, []);

  /* ================================================================
   * Fetch quote when ticker changes (debounced 400ms)
   * ============================================================= */
  useEffect(() => {
    const sym = ticker.trim().toUpperCase();
    if (!sym) {
      setQuote(null);
      setQuoteError('');
      setQuoteLoading(false);
      return;
    }

    let cancelled = false;
    setQuoteLoading(true);
    setQuoteError('');

    const timeout = setTimeout(async () => {
      try {
        const quotes = await fetchQuote([sym]);
        if (cancelled) return;
        const raw = Array.isArray(quotes) ? quotes[0] : quotes;
        if (!raw) {
          setQuoteError('No quote data returned');
          setQuote(null);
          return;
        }
        // Server normalizes to top-level bid/ask/last; support raw E*TRADE shape (data in .All) as fallback
        const q = raw.All ?? raw;
        const bid = typeof q.bid === 'number' ? q.bid : 0;
        const ask = typeof q.ask === 'number' ? q.ask : 0;
        const lastTrade = typeof q.lastTrade === 'number' ? q.lastTrade : 0;
        const lastNum = typeof q.last === 'number' ? q.last : 0;
        const last = lastTrade || lastNum || (bid && ask ? (bid + ask) / 2 : bid || ask || 0);
        setQuote({ bid, ask, last });
      } catch (err: any) {
        if (!cancelled) {
          setQuoteError(err.message || 'Failed to fetch quote');
          setQuote(null);
        }
      } finally {
        if (!cancelled) setQuoteLoading(false);
      }
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [ticker]);

  /* ================================================================
   * Update default quantity when quote changes (unless user edited)
   * ============================================================= */
  useEffect(() => {
    if (qtyManuallySet) return;
    if (!quote || quote.last <= 0) {
      setQuantity(100);
      return;
    }
    const maxByPrice = Math.floor(DEFAULT_MAX_NOTIONAL / quote.last);
    setQuantity(Math.min(100, Math.max(1, maxByPrice)));
  }, [quote, qtyManuallySet]);

  /* ================================================================
   * Default price type when buy/sell is selected (if not manually set)
   * Buy → BID, Sell → ASK. Only apply when we have a quote.
   * ============================================================= */
  useEffect(() => {
    if (priceTypeManuallySet || !action || !quote) return;
    setPriceType(action === 'BUY' ? 'BID' : 'ASK');
  }, [action, quote, priceTypeManuallySet]);

  /* ================================================================
   * Close history menu on outside click
   * ============================================================= */
  useEffect(() => {
    if (!historyMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        historyMenuRef.current &&
        !historyMenuRef.current.contains(e.target as Node)
      ) {
        setHistoryMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [historyMenuOpen]);

  /* ================================================================
   * Handlers
   * ============================================================= */

  const handleSelectHistory = (item: OrderHistoryItem) => {
    const d = item.draft;
    if (d.symbol) setTicker(d.symbol.toUpperCase());
    if (d.action === 'BUY' || d.action === 'BUY_TO_COVER') setAction('BUY');
    else if (d.action === 'SELL' || d.action === 'SELL_SHORT') setAction('SELL');
    if (d.quantity) {
      setQuantity(d.quantity);
      setQtyManuallySet(true);
    }
    setPriceTypeManuallySet(false);
    setPriceType(null);
    setHistoryMenuOpen(false);
    setError('');
    setSuccessMessage('');
  };

  const handleRefreshQuote = async () => {
    const sym = ticker.trim().toUpperCase();
    if (!sym) return;
    setQuoteLoading(true);
    setQuoteError('');
    try {
      const quotes = await fetchQuote([sym]);
      const raw = Array.isArray(quotes) ? quotes[0] : quotes;
      if (!raw) {
        setQuoteError('No quote data returned');
        setQuote(null);
        return;
      }
      const q = raw.All ?? raw;
      const bid = typeof q.bid === 'number' ? q.bid : 0;
      const ask = typeof q.ask === 'number' ? q.ask : 0;
      const lastTrade = typeof q.lastTrade === 'number' ? q.lastTrade : 0;
      const lastNum = typeof q.last === 'number' ? q.last : 0;
      const last = lastTrade || lastNum || (bid && ask ? (bid + ask) / 2 : bid || ask || 0);
      setQuote({ bid, ask, last });
    } catch (err: any) {
      setQuoteError(err.message || 'Failed to fetch quote');
      setQuote(null);
    } finally {
      setQuoteLoading(false);
    }
  };

  /* ── Computed values ────────────────────────────────────────── */

  const limitPrice =
    priceType && quote
      ? priceType === 'BID'
        ? quote.bid
        : quote.ask
      : null;

  const sessionTimeValue: string =
    session === 'NONE' ? 'MARKET' : 'EXTENDED';

  const isReady =
    !!action &&
    !!ticker.trim() &&
    !!priceType &&
    limitPrice != null &&
    limitPrice > 0 &&
    !!quantity &&
    !!accountId;

  /* ── Preview helpers ────────────────────────────────────────── */

  const buildPreview = (): string => {
    if (!action || !ticker.trim() || !priceType || limitPrice == null || !quantity)
      return '';
    const sessionLabel =
      session === 'EXTENDED'
        ? 'EXT'
        : session === 'HIDDEN'
          ? 'HIDDEN'
          : 'REG';
    return [
      action,
      quantity,
      ticker.trim().toUpperCase(),
      '@',
      `$${limitPrice.toFixed(2)}`,
      `(${priceType.toLowerCase()})`,
      'LIMIT',
      sessionLabel,
    ].join(' ');
  };

  const buildCommandPreview = (): string => {
    if (!action || !ticker.trim() || !priceType || limitPrice == null || !quantity)
      return '';

    const payload: Record<string, unknown> = {
      accountId,
      symbol: ticker.trim().toUpperCase(),
      securityType: 'EQUITY',
      action,
      orderType: 'LIMIT',
      quantity: typeof quantity === 'number' ? quantity : parseInt(String(quantity)),
      limitPrice: parseFloat(limitPrice.toFixed(2)),
      actualDuration: 'DAY',
      preferredDuration: 'DAY',
      sessionTime: sessionTimeValue,
      scheduleEnabled: false,
      status: 'PENDING',
      retryCount: 0,
      maxRetries: 3,
    };
    if (session === 'HIDDEN') {
      payload.notes = 'HIDDEN order';
    }

    return (
      `POST /api/orders\n` +
      JSON.stringify(payload, null, 2) +
      `\n\nthen POST /api/orders/{id}/submit`
    );
  };

  /* ── Send order ─────────────────────────────────────────────── */

  const handleSend = async () => {
    if (
      !action ||
      !ticker.trim() ||
      !priceType ||
      limitPrice == null ||
      !quantity ||
      !accountId
    ) {
      setError(
        'Please fill in all fields (ticker, action, price, quantity, account)'
      );
      return;
    }

    setError('');
    setSuccessMessage('');
    setSending(true);

    try {
      const orderPayload: Record<string, unknown> = {
        accountId,
        symbol: ticker.trim().toUpperCase(),
        securityType: 'EQUITY',
        action,
        orderType: 'LIMIT',
        quantity:
          typeof quantity === 'number' ? quantity : parseInt(String(quantity)),
        limitPrice: parseFloat(limitPrice.toFixed(2)),
        actualDuration: 'DAY',
        preferredDuration: 'DAY',
        sessionTime: sessionTimeValue,
        scheduleEnabled: false,
        status: 'PENDING',
        retryCount: 0,
        maxRetries: 3,
      };
      if (session === 'HIDDEN') {
        orderPayload.notes = 'HIDDEN order';
      }

      const created = await createOrder(orderPayload);
      const result = await submitOrder(created.id);

      if (!result.success) {
        throw new Error(
          result.order?.lastError || 'Order submission failed'
        );
      }

      setSuccessMessage(
        `Order sent! E*TRADE Order ID: ${result.order.etradeOrderId || 'Pending'}`
      );

      onOrderSent?.({
        accountId,
        symbol: ticker.trim().toUpperCase(),
        securityType: 'EQUITY',
        action,
        orderType: 'LIMIT',
        quantity:
          typeof quantity === 'number' ? quantity : parseInt(String(quantity)),
        limitPrice: limitPrice.toFixed(2),
        sessionTime: sessionTimeValue,
      });

      /* Reset selection (keep ticker & account) */
      setAction(null);
      setPriceType(null);
    } catch (err: any) {
      setError(err.message || 'Failed to send order');
    } finally {
      setSending(false);
    }
  };

  /* ── Filter history to stock orders ─────────────────────────── */
  const stockHistory = orderHistory.filter(
    (h) => !h.draft.securityType || h.draft.securityType === 'EQUITY'
  );

  /* ================================================================
   * RENDER
   * ============================================================= */
  return (
    <div className="w-full max-w-lg mx-auto px-2">
      {/* Backdrop when history menu is open */}
      {historyMenuOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm"
          aria-hidden="true"
        />
      )}

      <h2 className="text-lg font-semibold text-white mb-4">Quick Send</h2>

      {/* ─── Recent Orders dropdown ──────────────────────────────── */}
      {stockHistory.length > 0 && (
        <div className="relative mb-4" ref={historyMenuRef}>
          <button
            type="button"
            onClick={() => setHistoryMenuOpen((v) => !v)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-slate-300 text-sm hover:bg-slate-700 hover:text-white transition-colors outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
          >
            <span>Recent orders</span>
            <span className="text-slate-500">({stockHistory.length})</span>
            <svg
              className={`w-4 h-4 transition-transform ${historyMenuOpen ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
          {historyMenuOpen && (
            <div
              className="absolute left-0 right-0 mt-1 max-h-64 overflow-auto rounded-lg border border-slate-600 shadow-2xl shadow-black/70 z-50"
              style={{ backgroundColor: '#020617', opacity: 1 }}
            >
              <div
                className="sticky top-0 px-3 py-2 text-xs font-medium text-slate-300 border-b border-slate-700"
                style={{ backgroundColor: '#020617' }}
              >
                Click to prefill Quick Send form
              </div>
              {stockHistory.map((item) => (
                <div
                  key={item.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleSelectHistory(item)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleSelectHistory(item);
                    }
                  }}
                  className="flex items-center gap-2 px-3 py-2.5 text-left hover:bg-slate-800 text-slate-100 text-sm border-b border-slate-700 last:border-b-0 cursor-pointer outline-none focus-visible:bg-slate-900 focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  <span className="truncate flex-1 min-w-0">
                    {getHistoryItemLabel(item)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ─── Messages ────────────────────────────────────────────── */}
      {error && (
        <div className="mb-3 p-3 bg-red-500/20 border border-red-500 rounded-lg text-red-400 text-sm">
          {error}
        </div>
      )}
      {successMessage && (
        <div className="mb-3 p-3 bg-green-500/20 border border-green-500 rounded-lg text-green-400 text-sm">
          {successMessage}
        </div>
      )}
      {accountsError && (
        <div className="mb-3 p-3 bg-amber-500/20 border border-amber-500 rounded-lg text-amber-200 text-xs">
          {accountsError}. Enter an Account ID manually below.
        </div>
      )}

      <div className="bg-slate-800 rounded-lg p-5 space-y-5">
        {/* ─── Account ─────────────────────────────────────────────── */}
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">
            Account
          </label>
          {accountsLoading ? (
            <div className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-slate-400 text-sm">
              Loading...
            </div>
          ) : accounts.length > 0 ? (
            <select
              value={accountId}
              onChange={(e) => {
                const value = e.target.value;
                setAccountId(value);
                if (typeof window !== 'undefined') {
                  window.localStorage.setItem('selectedAccountIdKey', value);
                }
              }}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="" disabled>
                Select account
              </option>
              {accounts.map((a) => (
                <option key={a.accountIdKey} value={a.accountIdKey}>
                  {a.nickname} — {a.name || 'Unnamed'} ({a.type})
                  {a.isDefaultFromEnv ? ' [.env]' : ''}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder="E*TRADE account key"
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
            />
          )}
        </div>

        {/* ─── Ticker (BIG) ────────────────────────────────────────── */}
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">
            Ticker
          </label>
          <input
            type="text"
            value={ticker}
            onChange={(e) => {
              setTicker(e.target.value.toUpperCase());
              setPriceTypeManuallySet(false);
              setPriceType(null);
              setQtyManuallySet(false);
              setError('');
              setSuccessMessage('');
            }}
            placeholder="XOM"
            className="w-full px-4 py-4 bg-slate-700 border border-slate-600 rounded-lg text-white text-3xl font-bold text-center tracking-wider focus:outline-none focus:border-blue-500 uppercase placeholder:text-slate-500"
          />
          {quoteLoading && (
            <p className="text-xs text-slate-400 mt-1 text-center">
              Fetching quote...
            </p>
          )}
          {quoteError && (
            <p className="text-xs text-red-400 mt-1 text-center">
              {quoteError}
            </p>
          )}
          {quote && !quoteLoading && (
            <div className="flex items-center justify-center gap-4 mt-2 text-xs text-slate-400">
              <span>
                Bid:{' '}
                <span className="text-white font-medium">
                  ${quote.bid.toFixed(2)}
                </span>
              </span>
              <span>
                Ask:{' '}
                <span className="text-white font-medium">
                  ${quote.ask.toFixed(2)}
                </span>
              </span>
              <span>
                Last:{' '}
                <span className="text-white font-medium">
                  ${quote.last.toFixed(2)}
                </span>
              </span>
              <button
                type="button"
                onClick={handleRefreshQuote}
                disabled={quoteLoading}
                className="text-slate-400 hover:text-white transition-colors"
                title="Refresh quote"
              >
                <svg
                  className={`w-3.5 h-3.5 ${quoteLoading ? 'animate-spin' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  />
                </svg>
              </button>
            </div>
          )}
        </div>

        {/* ─── Buy / Sell toggle ───────────────────────────────────── */}
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-2">
            Action
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setAction('BUY');
                setPriceTypeManuallySet(false);
                setPriceType(null);
              }}
              className={`flex-1 py-3 rounded-lg font-semibold text-lg transition-colors ${
                action === 'BUY'
                  ? 'bg-green-600 text-white ring-2 ring-green-400'
                  : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }`}
            >
              BUY
            </button>
            <button
              type="button"
              onClick={() => {
                setAction('SELL');
                setPriceTypeManuallySet(false);
                setPriceType(null);
              }}
              className={`flex-1 py-3 rounded-lg font-semibold text-lg transition-colors ${
                action === 'SELL'
                  ? 'bg-red-600 text-white ring-2 ring-red-400'
                  : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }`}
            >
              SELL
            </button>
          </div>
        </div>

        {/* ─── Price buttons (bid / ask) ───────────────────────────── */}
        {action && quote && (
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-2">
              Limit Price
            </label>
            {action === 'BUY' ? (
              <div className="flex gap-2">
                {/* Buy at Bid — "with market" (maker), bold */}
                <button
                  type="button"
                  onClick={() => {
                    setPriceTypeManuallySet(true);
                    setPriceType('BID');
                  }}
                  className={`flex-1 py-3 rounded-lg text-center transition-colors ${
                    priceType === 'BID'
                      ? 'bg-green-600 text-white ring-2 ring-green-400'
                      : 'bg-green-900/40 text-green-300 hover:bg-green-800/40 border border-green-700'
                  }`}
                >
                  <span className="font-bold text-sm">Buy at Bid</span>
                  <br />
                  <span className="text-xl font-bold">
                    ${quote.bid.toFixed(2)}
                  </span>
                </button>
                {/* Buy at Ask — taker, normal weight */}
                <button
                  type="button"
                  onClick={() => {
                    setPriceTypeManuallySet(true);
                    setPriceType('ASK');
                  }}
                  className={`flex-1 py-3 rounded-lg text-center transition-colors ${
                    priceType === 'ASK'
                      ? 'bg-green-600 text-white ring-2 ring-green-400'
                      : 'bg-green-900/40 text-green-300 hover:bg-green-800/40 border border-green-700'
                  }`}
                >
                  <span className="text-sm">Buy at Ask</span>
                  <br />
                  <span className="text-xl">${quote.ask.toFixed(2)}</span>
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                {/* Sell at Bid — taker, normal weight */}
                <button
                  type="button"
                  onClick={() => {
                    setPriceTypeManuallySet(true);
                    setPriceType('BID');
                  }}
                  className={`flex-1 py-3 rounded-lg text-center transition-colors ${
                    priceType === 'BID'
                      ? 'bg-red-600 text-white ring-2 ring-red-400'
                      : 'bg-red-900/40 text-red-300 hover:bg-red-800/40 border border-red-700'
                  }`}
                >
                  <span className="text-sm">Sell at Bid</span>
                  <br />
                  <span className="text-xl">${quote.bid.toFixed(2)}</span>
                </button>
                {/* Sell at Ask — "with market" (maker), bold */}
                <button
                  type="button"
                  onClick={() => {
                    setPriceTypeManuallySet(true);
                    setPriceType('ASK');
                  }}
                  className={`flex-1 py-3 rounded-lg text-center transition-colors ${
                    priceType === 'ASK'
                      ? 'bg-red-600 text-white ring-2 ring-red-400'
                      : 'bg-red-900/40 text-red-300 hover:bg-red-800/40 border border-red-700'
                  }`}
                >
                  <span className="font-bold text-sm">Sell at Ask</span>
                  <br />
                  <span className="text-xl font-bold">
                    ${quote.ask.toFixed(2)}
                  </span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* ─── Session mode ────────────────────────────────────────── */}
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-2">
            Session
          </label>
          <div className="flex gap-4">
            {(
              [
                { value: 'HIDDEN', label: 'Hidden' },
                { value: 'EXTENDED', label: 'Extended (EXT)' },
                { value: 'NONE', label: 'None (regular)' },
              ] as { value: SessionMode; label: string }[]
            ).map((opt) => (
              <label
                key={opt.value}
                className="flex items-center gap-1.5 cursor-pointer"
              >
                <input
                  type="radio"
                  name="quicksend-session"
                  value={opt.value}
                  checked={session === opt.value}
                  onChange={() => setSession(opt.value)}
                  className="accent-blue-500"
                />
                <span
                  className={`text-sm ${
                    session === opt.value ? 'text-white' : 'text-slate-400'
                  }`}
                >
                  {opt.label}
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* ─── Quantity ────────────────────────────────────────────── */}
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">
            Quantity
            {quote && quote.last > 0 && (
              <span className="text-slate-500 font-normal ml-1">
                (auto: min of 100 or ~
                {Math.floor(DEFAULT_MAX_NOTIONAL / quote.last).toLocaleString()} shares
                for ${(DEFAULT_MAX_NOTIONAL / 1000).toFixed(0)}k — adjust DEFAULT_MAX_NOTIONAL for your account size)
              </span>
            )}
          </label>
          <input
            type="number"
            min={1}
            value={quantity}
            onChange={(e) => {
              const val = e.target.value;
              setQtyManuallySet(true);
              setQuantity(val === '' ? '' : Math.max(1, parseInt(val) || 1));
            }}
            className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
          />
        </div>

        {/* ─── Preview ─────────────────────────────────────────────── */}
        {isReady && (
          <div className="border border-slate-600 rounded-lg p-3 bg-slate-900/80">
            <div className="text-xs font-medium text-slate-400 mb-1">
              Order Preview
            </div>
            <div
              className={`font-mono text-base mb-3 font-semibold ${
                action === 'BUY' ? 'text-green-400' : 'text-red-400'
              }`}
            >
              {buildPreview()}
            </div>
            <div className="text-xs font-medium text-slate-400 mb-1">
              API Command
            </div>
            <pre className="text-slate-300 font-mono text-xs whitespace-pre-wrap break-all leading-relaxed max-h-48 overflow-auto">
              {buildCommandPreview()}
            </pre>
          </div>
        )}

        {/* ─── Warning + Send button ───────────────────────────────── */}
        <div>
          <div className="text-amber-400 text-xs mb-3 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2.5 leading-relaxed">
            <span className="font-semibold">WARNING:</span> This order will be
            sent right away once you press this button! Make sure it&apos;s
            accurate.
          </div>
          <button
            type="button"
            onClick={handleSend}
            disabled={!isReady || sending}
            className={`w-full py-3.5 rounded-lg font-bold text-lg transition-colors ${
              !isReady || sending
                ? 'bg-slate-600 text-slate-400 cursor-not-allowed'
                : action === 'BUY'
                  ? 'bg-green-600 hover:bg-green-700 text-white'
                  : action === 'SELL'
                    ? 'bg-red-600 hover:bg-red-700 text-white'
                    : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}
          >
            {sending
              ? 'Sending...'
              : isReady
                ? `SEND ${action} ORDER`
                : 'SEND ORDER'}
          </button>
        </div>
      </div>
    </div>
  );
}
