import React, { useEffect, useState, useRef } from 'react';
import {
  createOrder,
  fetchAccounts,
  fetchQuote,
  searchSymbols,
  type TradingAccount,
  type SymbolSearchResult,
} from '../utils/api';

type OrderFormDraft = Partial<{
  symbol: string;
  action: string;
  orderType: string;
  quantity: number;
  limitPrice: string;
  notes: string;
  securityType: 'EQUITY' | 'OPTION';
  optionType: 'CALL' | 'PUT';
  strikePrice: number;
  expirationDate: string;
}>;

interface OrderFormProps {
  draft?: OrderFormDraft;
}

const initialFormState = {
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
  preferredDuration: 'GTC',
  actualDuration: 'DAY',
  sessionTime: 'MARKET',
  scheduledFor: '',
  scheduleEnabled: false,
  notes: '',
};

export default function OrderForm({ draft }: OrderFormProps) {
  const [formData, setFormData] = useState({
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
    preferredDuration: 'GTC',
    actualDuration: 'DAY',
    sessionTime: 'MARKET',
    scheduledFor: '',
    scheduleEnabled: false,
    notes: '',
  });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
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

  // Apply external draft pre-fill when it changes
  useEffect(() => {
    if (!draft) return;

    setFormData((prev) => ({
      ...prev,
      symbol: draft.symbol ?? prev.symbol,
      securityType: draft.securityType ?? prev.securityType,
      optionType: draft.optionType ?? prev.optionType,
      strikePrice:
        draft.strikePrice != null
          ? String(draft.strikePrice)
          : prev.strikePrice,
      expirationDate: draft.expirationDate ?? prev.expirationDate,
      action: draft.action ?? prev.action,
      orderType: draft.orderType ?? prev.orderType,
      quantity: draft.quantity ?? prev.quantity,
      limitPrice: draft.limitPrice ?? prev.limitPrice,
      notes: draft.notes ?? prev.notes,
    }));
  }, [draft]);

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
          setAutoPricingError(err.message || 'Failed to fetch live price for limit order');
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess(false);
    setSubmitting(true);

    try {
      const orderData = {
        ...formData,
        quantity: parseInt(formData.quantity as any),
        limitPrice: formData.limitPrice ? parseFloat(formData.limitPrice) : undefined,
        stopPrice: formData.stopPrice ? parseFloat(formData.stopPrice) : undefined,
        strikePrice: formData.strikePrice ? parseFloat(formData.strikePrice) : undefined,
        expirationDate: formData.expirationDate
          ? new Date(formData.expirationDate)
          : undefined,
        scheduledFor: formData.scheduledFor ? new Date(formData.scheduledFor).toISOString() : undefined,
        requiresDaily: formData.preferredDuration !== formData.actualDuration,
        status: formData.scheduleEnabled ? 'SCHEDULED' : 'PENDING',
        retryCount: 0,
        maxRetries: 3,
      };

      await createOrder(orderData);
      setSuccess(true);

      // Reset form
      setFormData({
        ...initialFormState,
        accountId: formData.accountId,
      });
    } catch (err: any) {
      setError(err.message || 'Failed to create order');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <h2 className="text-xl font-semibold text-white mb-6">Create New Order</h2>

      {error && (
        <div className="mb-4 p-4 bg-red-500/20 border border-red-500 rounded-lg text-red-400">
          {error}
        </div>
      )}

      {success && (
        <div className="mb-4 p-4 bg-green-500/20 border border-green-500 rounded-lg text-green-400">
          Order created successfully!
        </div>
      )}

      {accountsError && (
        <div className="mb-4 p-3 bg-amber-500/20 border border-amber-500 rounded-lg text-amber-200 text-sm">
          {accountsError}. Enter an Account ID manually below.
        </div>
      )}

      {autoPricingError && (
        <div className="mb-4 p-3 bg-amber-500/20 border border-amber-500 rounded-lg text-amber-100 text-xs">
          {autoPricingError}
        </div>
      )}

      <form onSubmit={handleSubmit} className="bg-slate-800 rounded-lg p-6 space-y-6">
        <section className="space-y-4">
          <h3 className="text-sm font-medium text-slate-400 border-b border-slate-700 pb-2">
            Account & symbol
          </h3>
          <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Account ID
            </label>
            {accountsLoading ? (
              <div className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-slate-400 text-sm">
                Loading accounts...
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
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
              >
                <option value="" disabled>
                  Select an account
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
                placeholder="Enter E*TRADE account key"
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
              />
            )}
          </div>

          <div className="relative" ref={symbolInputRef}>
            <label className="block text-sm font-medium text-slate-300 mb-2">
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
              <div className="absolute z-20 mt-1 w-full max-h-56 overflow-auto rounded-md bg-slate-800 border border-slate-700 shadow-lg">
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
        </div>
        </section>

        <section className="space-y-4">
          <h3 className="text-sm font-medium text-slate-400 border-b border-slate-700 pb-2">
            Security & order
          </h3>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Security Type
            </label>
            <select
              value={formData.securityType}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  securityType: e.target.value as 'EQUITY' | 'OPTION',
                })
              }
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            >
              <option value="EQUITY">Equity</option>
              <option value="OPTION">Option</option>
            </select>
          </div>

          {formData.securityType === 'OPTION' && (
            <>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
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
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
                >
                  <option value="CALL">CALL</option>
                  <option value="PUT">PUT</option>
                </select>
              </div>

              <div className="col-span-1">
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  Exp / Strike
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="date"
                    value={formData.expirationDate}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        expirationDate: e.target.value,
                      })
                    }
                    className="px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500 text-xs"
                  />
                  <input
                    type="number"
                    step="0.01"
                    placeholder="Strike"
                    value={formData.strikePrice}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        strikePrice: e.target.value,
                      })
                    }
                    className="px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500 text-xs"
                  />
                </div>
              </div>
            </>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Action
            </label>
            <select
              value={formData.action}
              onChange={(e) => setFormData({ ...formData, action: e.target.value })}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            >
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
              <option value="BUY_TO_COVER">BUY TO COVER</option>
              <option value="SELL_SHORT">SELL SHORT</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Order Type
            </label>
            <select
              value={formData.orderType}
              onChange={(e) => setFormData({ ...formData, orderType: e.target.value })}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            >
              <option value="MARKET">MARKET</option>
              <option value="LIMIT">LIMIT</option>
              <option value="STOP">STOP</option>
              <option value="STOP_LIMIT">STOP LIMIT</option>
            </select>
          </div>
        </div>
        </section>

        <section className="space-y-4">
          <h3 className="text-sm font-medium text-slate-400 border-b border-slate-700 pb-2">
            Quantity & price
          </h3>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Quantity
            </label>
            <input
              type="number"
              required
              min="1"
              value={formData.quantity}
              onChange={(e) => setFormData({ ...formData, quantity: parseInt(e.target.value) || 1 })}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            />
          </div>

          {(formData.orderType === 'LIMIT' || formData.orderType === 'STOP_LIMIT') && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium text-slate-300">
                  Limit Price
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
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
              />
            </div>
          )}

          {(formData.orderType === 'STOP' || formData.orderType === 'STOP_LIMIT') && (
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                Stop Price
              </label>
              <input
                type="number"
                step="0.01"
                value={formData.stopPrice}
                onChange={(e) => setFormData({ ...formData, stopPrice: e.target.value })}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
              />
            </div>
          )}
        </div>
        </section>

        <section className="space-y-4">
          <h3 className="text-sm font-medium text-slate-400 border-b border-slate-700 pb-2">
            Duration & schedule
          </h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Preferred Duration
            </label>
            <select
              value={formData.preferredDuration}
              onChange={(e) => setFormData({ ...formData, preferredDuration: e.target.value })}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            >
              <option value="GTC">GTC (Good Till Cancel)</option>
              <option value="DAY">DAY</option>
              <option value="IMMEDIATE_OR_CANCEL">Immediate or Cancel</option>
              <option value="FILL_OR_KILL">Fill or Kill</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Actual Duration (What Gets Placed)
            </label>
            <select
              value={formData.actualDuration}
              onChange={(e) => setFormData({ ...formData, actualDuration: e.target.value })}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            >
              <option value="DAY">DAY</option>
              <option value="GTC">GTC</option>
              <option value="IMMEDIATE_OR_CANCEL">Immediate or Cancel</option>
              <option value="FILL_OR_KILL">Fill or Kill</option>
            </select>
          </div>
        </div>

        {formData.preferredDuration !== formData.actualDuration && (
          <div className="p-3 bg-amber-500/20 border border-amber-500/50 rounded-lg text-amber-400 text-sm">
            This order will be placed daily at the scheduled time since the preferred duration differs from actual duration.
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">
            Session Time
          </label>
          <select
            value={formData.sessionTime}
            onChange={(e) => setFormData({ ...formData, sessionTime: e.target.value })}
            className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
          >
            <option value="MARKET">Market Hours (9:30 AM)</option>
            <option value="EXTENDED">Extended Hours (7:00 AM)</option>
          </select>
        </div>

        <div>
          <label className="flex items-center gap-2 text-slate-300">
            <input
              type="checkbox"
              checked={formData.scheduleEnabled}
              onChange={(e) => setFormData({ ...formData, scheduleEnabled: e.target.checked })}
              className="w-4 h-4"
            />
            <span className="text-sm font-medium">Enable Scheduling</span>
          </label>
        </div>

        {formData.scheduleEnabled && (
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Schedule For
            </label>
            <input
              type="datetime-local"
              value={formData.scheduledFor}
              onChange={(e) => setFormData({ ...formData, scheduledFor: e.target.value })}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            />
          </div>
        )}
        </section>

        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">
            Notes (optional)
          </label>
          <textarea
            value={formData.notes}
            onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
            rows={3}
            className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 text-white font-medium rounded-lg transition-colors"
        >
          {submitting ? 'Creating...' : 'Create Order'}
        </button>
      </form>
    </div>
  );
}
