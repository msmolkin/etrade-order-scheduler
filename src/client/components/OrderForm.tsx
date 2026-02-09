import React, { useEffect, useState, useRef } from 'react';
import {
  createOrder,
  fetchAccounts,
  fetchOptionExpirations,
  fetchQuote,
  searchSymbols,
  submitOrder,
  type TradingAccount,
  type SymbolSearchResult,
} from '../utils/api';

export type OrderFormDraft = Partial<{
  accountId: string;
  symbol: string;
  action: string;
  orderType: string;
  quantity: number;
  limitPrice: string;
  stopPrice: string;
  notes: string;
  securityType: 'EQUITY' | 'OPTION';
  optionType: 'CALL' | 'PUT';
  strikePrice: number;
  expirationDate: string;
  preferredDuration: string;
  actualDuration: string;
  sessionTime: string;
  scheduleEnabled: boolean;
  scheduleFrequency: 'DAILY' | 'WEEKLY';
  scheduleOnce: boolean;
  scheduledFor: string;
}>;

interface OrderFormProps {
  draft?: OrderFormDraft;
  onOrderCreated?: (draft: OrderFormDraft) => void;
}

type FormState = {
  accountId: string;
  symbol: string;
  securityType: 'EQUITY' | 'OPTION';
  optionType: 'CALL' | 'PUT';
  strikePrice: string;
  expirationDate: string;
  action: 'BUY' | 'SELL' | 'BUY_TO_COVER' | 'SELL_SHORT';
  orderType: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT' | 'THRESHOLD';
  quantity: number | '';
  limitPrice: string;
  stopPrice: string;
  preferredDuration: string;
  actualDuration: string;
  sessionTime: 'MARKET' | 'EXTENDED';
  scheduledFor: string;
  scheduleEnabled: boolean;
  scheduleFrequency: 'DAILY' | 'WEEKLY';
  scheduleOnce: boolean;
  notes: string;
  thresholdEnabled: boolean;
  thresholdPrice: string;
  thresholdPriceSource: 'BID' | 'ASK' | 'LAST';
  thresholdQuantity: number;
  thresholdPollIntervalMs: number;
  thresholdLogFile: string;
  sellOrderEnabled: boolean;
  sellOrderThresholdPrice: string;
  sellOrderThresholdPriceSource: 'BID' | 'ASK' | 'LAST';
  sellOrderQuantity: number;
};

const initialFormState: FormState = {
  accountId: '',
  symbol: '',
  securityType: 'EQUITY',
  optionType: 'CALL' as 'CALL' | 'PUT',
  strikePrice: '',
  expirationDate: '',
  action: 'BUY',
  orderType: 'LIMIT',
  quantity: 1,
  limitPrice: '',
  stopPrice: '',
  preferredDuration: 'DAY',
  actualDuration: 'DAY',
  sessionTime: 'EXTENDED',
  scheduledFor: '',
  scheduleEnabled: true,
  scheduleFrequency: 'DAILY',
  scheduleOnce: false,
  notes: '',
  thresholdEnabled: false,
  thresholdPrice: '',
  thresholdPriceSource: 'BID' as 'BID' | 'ASK' | 'LAST',
  thresholdQuantity: 1,
  thresholdPollIntervalMs: 1000,
  thresholdLogFile: '',
  sellOrderEnabled: false,
  sellOrderThresholdPrice: '',
  sellOrderThresholdPriceSource: 'ASK' as 'BID' | 'ASK' | 'LAST',
  sellOrderQuantity: 1,
};

export default function OrderForm({ draft, onOrderCreated }: OrderFormProps) {
  const [formData, setFormData] = useState<FormState>(initialFormState);

  const [submitting, setSubmitting] = useState(false);
  const [sendingNow, setSendingNow] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [accounts, setAccounts] = useState<TradingAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState('');
  const [autoPricing, setAutoPricing] = useState(false);
  const [autoPricingError, setAutoPricingError] = useState('');
  const [symbolResults, setSymbolResults] = useState<SymbolSearchResult[]>([]);
  const [symbolSearchLoading, setSymbolSearchLoading] = useState(false);
  const [symbolSearchError, setSymbolSearchError] = useState('');
  const [showSymbolDropdown, setShowSymbolDropdown] = useState(false);
  const symbolInputRef = useRef<HTMLDivElement>(null);
  const [optionExpirations, setOptionExpirations] = useState<string[]>([]);
  const [optionExpirationsLoading, setOptionExpirationsLoading] = useState(false);
  const [optionExpirationsError, setOptionExpirationsError] = useState('');
  const [scheduledForTouched, setScheduledForTouched] = useState(false);

  useEffect(() => {
    const loadAccounts = async () => {
      try {
        setAccountsLoading(true);
        setAccountsError('');

        const storedAccountIdKey =
          typeof window !== 'undefined'
            ? window.localStorage.getItem('selectedAccountIdKey')
            : null;

        const { accounts: fetchedAccounts, defaultAccountIdKey } = await fetchAccounts();
        setAccounts(fetchedAccounts);

        const initialAccountIdKey =
          storedAccountIdKey && fetchedAccounts.some((a) => a.accountIdKey === storedAccountIdKey)
            ? storedAccountIdKey
            : defaultAccountIdKey;

        if (initialAccountIdKey) {
          setFormData((prev) => ({
            ...prev,
            accountId: initialAccountIdKey,
          }));
        }
      } catch (err: any) {
        setAccountsError(err.message || 'Failed to load accounts');
      } finally {
        setAccountsLoading(false);
      }
    };

    loadAccounts();
  }, []);

  // Fetch real option expiration dates when symbol is set and security type is OPTION
  useEffect(() => {
    const symbol = formData.symbol.trim();
    if (formData.securityType !== 'OPTION' || !symbol) {
      setOptionExpirations([]);
      setOptionExpirationsError('');
      return;
    }

    let cancelled = false;
    setOptionExpirationsLoading(true);
    setOptionExpirationsError('');

    fetchOptionExpirations(symbol)
      .then((dates) => {
        if (!cancelled) {
          setOptionExpirations(dates);
          setOptionExpirationsError('');
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setOptionExpirations([]);
          setOptionExpirationsError(err.message || 'Failed to load expirations');
        }
      })
      .finally(() => {
        if (!cancelled) setOptionExpirationsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [formData.securityType, formData.symbol]);

  // When option expirations load, clear expirationDate if it's not in the list
  useEffect(() => {
    if (
      formData.securityType !== 'OPTION' ||
      optionExpirations.length === 0 ||
      !formData.expirationDate
    )
      return;
    const valid = optionExpirations.includes(formData.expirationDate);
    if (!valid) {
      setFormData((prev) => ({ ...prev, expirationDate: '' }));
    }
  }, [optionExpirations, formData.securityType, formData.expirationDate]);

  // Apply external draft pre-fill when it changes
  useEffect(() => {
    if (!draft) return;

    setFormData((prev) => ({
      ...prev,
      accountId: draft.accountId ?? prev.accountId,
      symbol: draft.symbol ?? prev.symbol,
      securityType:
        draft.securityType === 'EQUITY' || draft.securityType === 'OPTION'
          ? draft.securityType
          : prev.securityType,
      optionType:
        draft.optionType === 'CALL' || draft.optionType === 'PUT'
          ? draft.optionType
          : prev.optionType,
      strikePrice:
        draft.strikePrice != null
          ? String(draft.strikePrice)
          : prev.strikePrice,
      expirationDate: draft.expirationDate ?? prev.expirationDate,
      action:
        draft.action === 'BUY' ||
        draft.action === 'SELL' ||
        draft.action === 'BUY_TO_COVER' ||
        draft.action === 'SELL_SHORT'
          ? draft.action
          : prev.action,
      orderType:
        draft.orderType === 'MARKET' ||
        draft.orderType === 'LIMIT' ||
        draft.orderType === 'STOP' ||
        draft.orderType === 'STOP_LIMIT' ||
        draft.orderType === 'THRESHOLD'
          ? draft.orderType
          : prev.orderType,
      quantity: draft.quantity ?? prev.quantity,
      limitPrice: draft.limitPrice ?? prev.limitPrice,
      stopPrice: draft.stopPrice ?? prev.stopPrice,
      preferredDuration: draft.preferredDuration ?? prev.preferredDuration,
      actualDuration: draft.actualDuration ?? prev.actualDuration,
      sessionTime:
        draft.sessionTime === 'MARKET' || draft.sessionTime === 'EXTENDED'
          ? draft.sessionTime
          : prev.sessionTime,
      scheduleEnabled: draft.scheduleEnabled ?? prev.scheduleEnabled,
      scheduleFrequency:
        draft.scheduleFrequency === 'DAILY' || draft.scheduleFrequency === 'WEEKLY'
          ? draft.scheduleFrequency
          : prev.scheduleFrequency,
      scheduleOnce: draft.scheduleOnce ?? prev.scheduleOnce,
      scheduledFor: draft.scheduledFor ?? prev.scheduledFor,
      notes: draft.notes ?? prev.notes,
    }));
  }, [draft]);

  const getNextTradingDay = (sessionTime: string): Date => {
    const next = new Date();
    const hour = sessionTime === 'EXTENDED' ? 7 : 9;
    const minute = sessionTime === 'EXTENDED' ? 0 : 30;
    next.setHours(hour, minute, 0, 0);
    next.setDate(next.getDate() + 1);
    const day = next.getDay();
    if (day === 0) next.setDate(next.getDate() + 1);
    if (day === 6) next.setDate(next.getDate() + 2);
    return next;
  };

  const formatDateTimeLocal = (date: Date): string => {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
      date.getHours()
    )}:${pad(date.getMinutes())}`;
  };

  const getSuggestedScheduleFor = (sessionTime: string): string =>
    formatDateTimeLocal(getNextTradingDay(sessionTime));

  useEffect(() => {
    if (!formData.scheduleEnabled) return;
    if (scheduledForTouched) return;
    const nextValue = getSuggestedScheduleFor(formData.sessionTime);
    if (formData.scheduledFor !== nextValue) {
      setFormData((prev) => ({ ...prev, scheduledFor: nextValue }));
    }
  }, [formData.scheduleEnabled, formData.sessionTime, scheduledForTouched]);

  // Search for symbols as user types
  useEffect(() => {
    const query = formData.symbol.trim();

    if (!query || query.length < 2) {
      setSymbolResults([]);
      setShowSymbolDropdown(false);
      setSymbolSearchError('');
      setSymbolSearchLoading(false);
      return;
    }

    let cancelled = false;
    setSymbolSearchLoading(true);
    setSymbolSearchError('');

    const timeoutId = setTimeout(async () => {
      try {
        const results = await searchSymbols(query);
        if (cancelled) return;

        setSymbolResults(results);
        setShowSymbolDropdown(results.length > 0);
      } catch (err: any) {
        if (cancelled) return;
        setSymbolResults([]);
        setShowSymbolDropdown(false);
        setSymbolSearchError(
          err.message || 'Failed to search symbols'
        );
      } finally {
        if (!cancelled) {
          setSymbolSearchLoading(false);
        }
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [formData.symbol]);

  const handleSelectSymbol = (result: SymbolSearchResult) => {
    setFormData((prev) => ({
      ...prev,
      symbol: result.symbol.toUpperCase(),
    }));
    setShowSymbolDropdown(false);
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        symbolInputRef.current &&
        !symbolInputRef.current.contains(event.target as Node)
      ) {
        setShowSymbolDropdown(false);
      }
    };

    if (showSymbolDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [showSymbolDropdown]);

  // When using LIMIT orders, automatically set limit price to current bid/ask.
  useEffect(() => {
    const shouldAutoPrice =
      formData.orderType === 'LIMIT' &&
      !!formData.symbol &&
      (formData.action === 'BUY' ||
        formData.action === 'SELL' ||
        formData.action === 'BUY_TO_COVER' ||
        formData.action === 'SELL_SHORT');

    if (!shouldAutoPrice) {
      setAutoPricing(false);
      setAutoPricingError('');
      return;
    }

    let cancelled = false;
    setAutoPricing(true);
    setAutoPricingError('');

    const loadQuote = async () => {
      try {
        const quotes = await fetchQuote([formData.symbol]);
        const quote = Array.isArray(quotes) ? quotes[0] : quotes;
        if (!quote || cancelled) return;

        const bid = typeof quote.bid === 'number' ? quote.bid : undefined;
        const ask = typeof quote.ask === 'number' ? quote.ask : undefined;

        let nextLimit: number | undefined;
        if (formData.action === 'BUY' || formData.action === 'BUY_TO_COVER') {
          nextLimit = ask ?? bid;
        } else if (formData.action === 'SELL' || formData.action === 'SELL_SHORT') {
          nextLimit = bid ?? ask;
        }

        if (nextLimit && !cancelled) {
          setFormData((prev) => ({
            ...prev,
            limitPrice: nextLimit.toFixed(2),
          }));
        }
      } catch (err: any) {
        if (!cancelled) {
          const msg = err?.message ?? '';
          setAutoPricingError(
            msg === 'Failed to fetch'
              ? 'Could not reach server for live price. Enter limit price manually.'
              : msg || 'Failed to fetch live price for limit order'
          );
        }
      } finally {
        if (!cancelled) {
          setAutoPricing(false);
        }
      }
    };

    loadQuote();

    return () => {
      cancelled = true;
    };
    // Re-run when symbol, orderType, or action changes
  }, [formData.symbol, formData.orderType, formData.action]);

  const buildOrderPayload = (overrides?: Partial<typeof formData>) => {
    const data = { ...formData, ...overrides };
    const scheduleFrequency = data.scheduleFrequency ?? 'DAILY';
    const scheduleEnabled = data.scheduleEnabled;
    return {
      ...data,
      quantity: parseInt(data.quantity as any),
      limitPrice: data.limitPrice ? parseFloat(data.limitPrice) : undefined,
      stopPrice: data.stopPrice ? parseFloat(data.stopPrice) : undefined,
      strikePrice: data.strikePrice ? parseFloat(data.strikePrice) : undefined,
      expirationDate: data.expirationDate
        ? (data.expirationDate.match(/^\d{4}-\d{2}-\d{2}$/)
            ? data.expirationDate
            : new Date(data.expirationDate).toISOString().slice(0, 10))
        : undefined,
      scheduledFor:
        scheduleEnabled && data.scheduledFor
          ? new Date(data.scheduledFor).toISOString()
          : undefined,
      preferredDuration: data.actualDuration,
      scheduleFrequency,
      requiresDaily: scheduleEnabled && scheduleFrequency === 'DAILY' && !data.scheduleOnce,
      status: scheduleEnabled ? 'SCHEDULED' : 'PENDING',
      retryCount: 0,
      maxRetries: 3,
      thresholdEnabled: data.orderType === 'THRESHOLD' || data.thresholdEnabled,
      thresholdPrice: data.thresholdPrice ? parseFloat(data.thresholdPrice) : undefined,
      thresholdPriceSource: data.thresholdPriceSource,
      thresholdQuantity: data.thresholdQuantity,
      thresholdPollIntervalMs: data.thresholdPollIntervalMs,
      thresholdLogFile: data.thresholdLogFile || undefined,
      sellOrderEnabled: data.sellOrderEnabled,
      sellOrderThresholdPrice: data.sellOrderThresholdPrice
        ? parseFloat(data.sellOrderThresholdPrice)
        : undefined,
      sellOrderThresholdPriceSource: data.sellOrderThresholdPriceSource,
      sellOrderQuantity: data.sellOrderQuantity,
    };
  };

  const buildDraftForHistory = (data: typeof formData): OrderFormDraft => ({
    accountId: data.accountId,
    symbol: data.symbol,
    securityType: data.securityType,
    optionType: data.optionType,
    strikePrice: data.strikePrice ? parseFloat(data.strikePrice) : undefined,
    expirationDate: data.expirationDate || undefined,
    action: data.action,
    orderType: data.orderType,
    quantity: typeof data.quantity === 'number' ? data.quantity : parseInt(String(data.quantity), 10),
    limitPrice: data.limitPrice || undefined,
    stopPrice: data.stopPrice || undefined,
    preferredDuration: data.actualDuration,
    actualDuration: data.actualDuration,
    sessionTime: data.sessionTime,
    scheduleEnabled: data.scheduleEnabled,
    scheduleFrequency: data.scheduleFrequency,
    scheduleOnce: data.scheduleOnce,
    scheduledFor: data.scheduledFor || undefined,
    notes: data.notes || undefined,
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccessMessage('');
    setSubmitting(true);

    try {
      const orderData = buildOrderPayload();
      await createOrder(orderData);
      setSuccessMessage('Order created successfully!');
      setAutoPricingError('');

      onOrderCreated?.(buildDraftForHistory(formData));

      // Reset form
      setFormData({
        ...initialFormState,
        accountId: formData.accountId,
        thresholdPriceSource: formData.action === 'BUY' ? 'BID' : 'ASK',
        sellOrderThresholdPriceSource: 'ASK',
      });
    } catch (err: any) {
      setError(err.message || 'Failed to create order');
      setSuccessMessage('');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSendNow = async () => {
    setError('');
    setSuccessMessage('');
    setSendingNow(true);

    try {
      const orderData = buildOrderPayload({
        scheduleEnabled: false,
        scheduleOnce: false,
        scheduledFor: '',
      });
      const created = await createOrder(orderData);
      onOrderCreated?.(buildDraftForHistory(formData));

      const result = await submitOrder(created.id);
      if (!result.success) {
        throw new Error(result.order?.lastError || 'Order submission failed');
      }

      setSuccessMessage(
        `Order sent now! E*TRADE Order ID: ${result.order.etradeOrderId || 'Pending'}`
      );
      setAutoPricingError('');

      // Reset form
      setFormData({
        ...initialFormState,
        accountId: formData.accountId,
        thresholdPriceSource: formData.action === 'BUY' ? 'BID' : 'ASK',
        sellOrderThresholdPriceSource: 'ASK',
      });
      setScheduledForTouched(false);
    } catch (err: any) {
      setError(err.message || 'Failed to send order now');
      setSuccessMessage('');
    } finally {
      setSendingNow(false);
    }
  };

  return (
    <div className="w-full max-w-md mx-auto px-2">
      <h2 className="text-lg font-semibold text-white mb-4">Create Order</h2>

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

      {autoPricingError && (
        <div className="mb-3 p-3 bg-amber-500/20 border border-amber-500 rounded-lg text-amber-100 text-xs">
          {autoPricingError}
        </div>
      )}

      <form onSubmit={handleSubmit} className="bg-slate-800 rounded-lg p-4 space-y-4">
        <section className="space-y-3">
          <h3 className="text-sm font-medium text-slate-400 border-b border-slate-700 pb-2">
            Account & symbol
          </h3>
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
                required
                value={formData.accountId}
                onChange={(e) => {
                  const value = e.target.value;
                  setFormData({ ...formData, accountId: value });
                  if (typeof window !== 'undefined') {
                    window.localStorage.setItem('selectedAccountIdKey', value);
                  }
                }}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
              >
                <option value="" disabled>
                  Select account
                </option>
                {accounts.map((account) => (
                  <option key={account.accountIdKey} value={account.accountIdKey}>
                    {account.nickname} — {account.name || 'Unnamed'} ({account.type}
                    {account.status !== 'ACTIVE' ? `, ${account.status}` : ''})
                    {account.isDefaultFromEnv ? ' [from .env ACCOUNT]' : ''}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                required
                value={formData.accountId}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    accountId: e.target.value,
                  })
                }
                placeholder="E*TRADE account key"
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
              />
            )}
          </div>

          <div className="relative" ref={symbolInputRef}>
            <label className="block text-xs font-medium text-slate-400 mb-1">
              Symbol
            </label>
            <input
              type="text"
              required
              value={formData.symbol}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  symbol: e.target.value.toUpperCase(),
                })
              }
              onKeyDown={(e) => {
                const key = e.key;
                if (key === 'Enter') {
                  // Use the typed symbol rather than submitting the form.
                  e.preventDefault();
                  const query = formData.symbol.trim().toUpperCase();
                  if (!query) return;

                  const exact = symbolResults.find(
                    (r) => r.symbol.toUpperCase() === query
                  );
                  if (exact) {
                    handleSelectSymbol(exact);
                  } else {
                    setFormData((prev) => ({
                      ...prev,
                      symbol: query,
                    }));
                    setShowSymbolDropdown(false);
                  }
                } else if (key === 'Tab') {
                  // When tabbing away, accept the typed symbol and close dropdown.
                  const query = formData.symbol.trim().toUpperCase();
                  if (query) {
                    setFormData((prev) => ({
                      ...prev,
                      symbol: query,
                    }));
                  }
                  setShowSymbolDropdown(false);
                }
              }}
              onFocus={() => {
                if (symbolResults.length > 0) {
                  setShowSymbolDropdown(true);
                }
              }}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            />
            {symbolSearchLoading && (
              <div className="absolute right-3 top-9 text-xs text-slate-400">
                Searching...
              </div>
            )}
            {symbolSearchError && (
              <div className="mt-1 text-xs text-amber-300">
                {symbolSearchError}
              </div>
            )}
            {showSymbolDropdown && symbolResults.length > 0 && (
              <div className="absolute z-20 mt-1 w-full max-h-48 overflow-auto rounded bg-slate-800 border border-slate-700 shadow-lg">
                {symbolResults.map((result) => (
                  <button
                    key={`${result.symbol}-${result.exchange}-${result.securityType}`}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handleSelectSymbol(result);
                    }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-slate-700 text-slate-100 flex flex-col"
                  >
                    <span className="font-semibold">
                      {result.symbol}{' '}
                      {result.exchange && (
                        <span className="text-xs text-slate-400">
                          ({result.exchange})
                        </span>
                      )}
                    </span>
                    {result.companyName && (
                      <span className="text-xs text-slate-300">
                        {result.companyName}
                      </span>
                    )}
                    {result.securityType && (
                      <span className="text-[10px] uppercase text-slate-500 mt-0.5">
                        {result.securityType}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-medium text-slate-400 border-b border-slate-700 pb-2">
            Security & order
          </h3>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">
              Security type
            </label>
            <select
              value={formData.securityType}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  securityType: e.target.value as 'EQUITY' | 'OPTION',
                })
              }
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="EQUITY">Equity</option>
              <option value="OPTION">Option</option>
            </select>
          </div>

          {formData.securityType === 'OPTION' && (
            <>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  Call / Put
                </label>
                <select
                  value={formData.optionType}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      optionType: e.target.value as 'CALL' | 'PUT',
                    })
                  }
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
                >
                  <option value="CALL">CALL</option>
                  <option value="PUT">PUT</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  Expiration
                </label>
                {optionExpirationsLoading ? (
                  <div className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-slate-400 text-sm">
                    Loading expirations…
                  </div>
                ) : optionExpirationsError ? (
                  <div className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-amber-400 text-sm">
                    {optionExpirationsError}
                  </div>
                ) : optionExpirations.length > 0 ? (
                  <select
                    value={formData.expirationDate}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        expirationDate: e.target.value,
                      })
                    }
                    className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
                  >
                    <option value="">Select expiration</option>
                    {optionExpirations.map((date) => (
                      <option key={date} value={date}>
                        {date}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-slate-400 text-sm">
                    Enter a symbol and select Option to load expirations
                  </div>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  Strike
                </label>
                <input
                  type="number"
                  step="0.01"
                  placeholder="Strike price"
                  value={formData.strikePrice}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      strikePrice: e.target.value,
                    })
                  }
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
                />
              </div>
            </>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">
              Action
            </label>
            <select
              value={formData.action}
              onChange={(e) => {
                const newAction = e.target.value as FormState['action'];
                setFormData({
                  ...formData,
                  action: newAction,
                  // Update default price source when action changes for threshold orders
                  thresholdPriceSource:
                    formData.orderType === 'THRESHOLD'
                      ? newAction === 'BUY'
                        ? 'BID'
                        : 'ASK'
                      : formData.thresholdPriceSource,
                });
              }}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            >
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
              <option value="BUY_TO_COVER">BUY TO COVER</option>
              <option value="SELL_SHORT">SELL SHORT</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">
              Order type
            </label>
            <select
              value={formData.orderType}
              onChange={(e) => {
                const newOrderType = e.target.value as FormState['orderType'];
                setFormData({
                  ...formData,
                  orderType: newOrderType,
                  thresholdEnabled: newOrderType === 'THRESHOLD',
                  // Set default price source based on action when switching to THRESHOLD
                  thresholdPriceSource:
                    newOrderType === 'THRESHOLD'
                      ? formData.action === 'BUY'
                        ? 'BID'
                        : 'ASK'
                      : formData.thresholdPriceSource,
                });
              }}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="MARKET">MARKET</option>
              <option value="LIMIT">LIMIT</option>
              <option value="STOP">STOP</option>
              <option value="STOP_LIMIT">STOP LIMIT</option>
              <option value="THRESHOLD">THRESHOLD</option>
            </select>
          </div>

          {formData.orderType === 'THRESHOLD' && (
            <>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  Threshold price
                </label>
                <input
                  type="number"
                  required
                  step="0.01"
                  placeholder="Target price"
                  value={formData.thresholdPrice}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      thresholdPrice: e.target.value,
                    })
                  }
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  Price source
                </label>
                <select
                  value={formData.thresholdPriceSource}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      thresholdPriceSource: e.target.value as 'BID' | 'ASK' | 'LAST',
                    })
                  }
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
                >
                  <option value="BID">BID</option>
                  <option value="ASK">ASK</option>
                  <option value="LAST">LAST</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  Threshold quantity
                </label>
                <input
                  type="number"
                  required
                  min="1"
                  value={formData.thresholdQuantity}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      thresholdQuantity: parseInt(e.target.value) || 1,
                    })
                  }
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  Poll interval (ms)
                </label>
                <input
                  type="number"
                  min="100"
                  step="100"
                  value={formData.thresholdPollIntervalMs}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      thresholdPollIntervalMs: parseInt(e.target.value) || 1000,
                    })
                  }
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
                />
                <p className="text-xs text-slate-500 mt-1">
                  How often to check price (default: 1000ms = 1 second)
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  Log file path (optional)
                </label>
                <input
                  type="text"
                  placeholder="logs/quotes-SYMBOL-timestamp.csv"
                  value={formData.thresholdLogFile}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      thresholdLogFile: e.target.value,
                    })
                  }
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Auto-generated if empty: logs/quotes-{formData.symbol || 'SYMBOL'}-timestamp.csv
                </p>
              </div>

              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="sellOrderEnabled"
                  checked={formData.sellOrderEnabled}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      sellOrderEnabled: e.target.checked,
                    })
                  }
                  className="w-4 h-4 bg-slate-700 border-slate-600 rounded text-blue-600 focus:ring-blue-500"
                />
                <label htmlFor="sellOrderEnabled" className="text-xs font-medium text-slate-400">
                  Enable sell order after buy executes
                </label>
              </div>

              {formData.sellOrderEnabled && formData.action === 'BUY' && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">
                      Sell threshold price
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="Sell target price"
                      value={formData.sellOrderThresholdPrice}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          sellOrderThresholdPrice: e.target.value,
                        })
                      }
                      className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">
                      Sell price source
                    </label>
                    <select
                      value={formData.sellOrderThresholdPriceSource}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          sellOrderThresholdPriceSource: e.target.value as 'BID' | 'ASK' | 'LAST',
                        })
                      }
                      className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
                    >
                      <option value="BID">BID</option>
                      <option value="ASK">ASK</option>
                      <option value="LAST">LAST</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">
                      Sell quantity
                    </label>
                    <input
                      type="number"
                      min="1"
                      value={formData.sellOrderQuantity}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          sellOrderQuantity: parseInt(e.target.value) || 1,
                        })
                      }
                      className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
                    />
                  </div>
                </>
              )}
            </>
          )}
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-medium text-slate-400 border-b border-slate-700 pb-2">
            Quantity & price
          </h3>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">
              Quantity
            </label>
            <input
              type="number"
              required
              min="1"
              value={formData.quantity}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === '') {
                  // Allow temporarily empty while typing/backspacing.
                  setFormData({ ...formData, quantity: '' as any });
                  return;
                }
                const parsed = parseInt(raw, 10);
                if (Number.isNaN(parsed)) {
                  return;
                }
                setFormData({
                  ...formData,
                  quantity: parsed < 1 ? (1 as any) : (parsed as any),
                });
              }}
              onBlur={() => {
                if (!formData.quantity) {
                  setFormData({ ...formData, quantity: 1 as any });
                }
              }}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
            />
          </div>

          {(formData.orderType === 'LIMIT' || formData.orderType === 'STOP_LIMIT') && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-medium text-slate-400">
                  Limit price
                </label>
                {autoPricing && (
                  <span className="text-xs text-slate-400">Syncing with market...</span>
                )}
              </div>
              <input
                type="number"
                step="0.01"
                value={formData.limitPrice}
                onChange={(e) => setFormData({ ...formData, limitPrice: e.target.value })}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
          )}

          {(formData.orderType === 'STOP' || formData.orderType === 'STOP_LIMIT') && (
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                Stop price
              </label>
              <input
                type="number"
                step="0.01"
                value={formData.stopPrice}
                onChange={(e) => setFormData({ ...formData, stopPrice: e.target.value })}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
          )}
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-medium text-slate-400 border-b border-slate-700 pb-2">
            Duration & schedule
          </h3>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">
              Placement frequency
            </label>
            <select
              value={formData.scheduleFrequency}
              onChange={(e) =>
                setFormData({ ...formData, scheduleFrequency: e.target.value as 'DAILY' | 'WEEKLY' })
              }
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="DAILY">Every trading day</option>
              <option value="WEEKLY">Once per week</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">
              Order term sent to E*TRADE
            </label>
            <select
              value={formData.actualDuration}
              onChange={(e) => setFormData({ ...formData, actualDuration: e.target.value })}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="DAY">DAY</option>
              <option value="GTC">GTC</option>
              <option value="IMMEDIATE_OR_CANCEL">Immediate or Cancel</option>
              <option value="FILL_OR_KILL">Fill or Kill</option>
            </select>
          </div>

          {formData.scheduleEnabled && (
            <div className="p-3 bg-amber-500/20 border border-amber-500/50 rounded-lg text-amber-400 text-sm">
              {formData.scheduleOnce
                ? 'Runs once at the scheduled time.'
                : formData.scheduleFrequency === 'WEEKLY'
                  ? 'Repeats once per week at the scheduled time.'
                  : 'Repeats every trading day at the scheduled time.'}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">
              Session time
            </label>
            <select
              value={formData.sessionTime}
              onChange={(e) =>
                setFormData({ ...formData, sessionTime: e.target.value as FormState['sessionTime'] })
              }
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="EXTENDED">Extended hours (7:00 AM ET)</option>
              <option value="MARKET">Market hours (9:30 AM ET)</option>
            </select>
            <p className="mt-1 text-xs text-slate-500">
              This sets the default time when no explicit schedule time is chosen.
            </p>
          </div>

          <div>
            <label className="flex items-center gap-2 text-slate-400 text-xs font-medium">
              <input
                type="checkbox"
                checked={formData.scheduleEnabled}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  setFormData((prev) => ({
                    ...prev,
                    scheduleEnabled: enabled,
                    scheduledFor: enabled ? prev.scheduledFor : '',
                  }));
                  if (!enabled) {
                    setScheduledForTouched(false);
                  }
                }}
                className="w-4 h-4"
              />
              Schedule this order
            </label>
          </div>

          {formData.scheduleEnabled && (
            <>
              <div>
                <label className="flex items-center gap-2 text-slate-400 text-xs font-medium">
                  <input
                    type="checkbox"
                    checked={formData.scheduleOnce}
                    onChange={(e) => setFormData({ ...formData, scheduleOnce: e.target.checked })}
                    className="w-4 h-4"
                  />
                  Schedule only once (ignores placement frequency)
                </label>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  Schedule time
                </label>
                <input
                  type="datetime-local"
                  value={formData.scheduledFor}
                  onChange={(e) => {
                    const value = e.target.value;
                    setScheduledForTouched(value !== '');
                    setFormData({ ...formData, scheduledFor: value });
                  }}
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
                />
                <p className="mt-1 text-xs text-slate-500">
                  {formData.scheduledFor
                    ? 'This is the next trading day for the selected session unless you change it.'
                    : `Leave blank to run the next trading day at ${
                        formData.sessionTime === 'EXTENDED' ? '7:00 AM ET' : '9:30 AM ET'
                      }.`}
                </p>
              </div>
            </>
          )}
        </section>

        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">
            Notes (optional)
          </label>
          <textarea
            value={formData.notes}
            onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
            rows={2}
            className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
          />
        </div>

        <div className="flex flex-col gap-2">
          <button
            type="submit"
            disabled={submitting || sendingNow}
            className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 text-white text-sm font-medium rounded transition-colors"
          >
            {submitting ? 'Creating...' : 'Create Order'}
          </button>
          <button
            type="button"
            onClick={handleSendNow}
            disabled={sendingNow || submitting}
            className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-600 text-white text-sm font-medium rounded transition-colors"
          >
            {sendingNow ? 'Sending...' : 'Send Now'}
          </button>
        </div>
      </form>
    </div>
  );
}
