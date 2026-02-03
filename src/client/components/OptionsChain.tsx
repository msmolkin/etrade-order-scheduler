import React, { useMemo, useState } from 'react';
import { fetchOptionsChain } from '../utils/api';

interface OptionsChainProps {
  onCreateOrderFromOption?: (params: {
    symbol: string;
    optionType: 'CALL' | 'PUT';
    strikePrice: number;
    expirationDate: string;
    side: 'BUY' | 'SELL';
    price: number;
  }) => void;
}

export default function OptionsChain({ onCreateOrderFromOption }: OptionsChainProps) {
  const [symbol, setSymbol] = useState('');
  const [expirationDate, setExpirationDate] = useState('');
  const [chainData, setChainData] = useState<any>(null);
  const [activeExpiry, setActiveExpiry] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!symbol) return;

    setError('');
    setLoading(true);
    setChainData(null);

    try {
      const data = await fetchOptionsChain(symbol, expirationDate || undefined);
      setChainData(data);
      setActiveExpiry(expirationDate || null);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch options chain');
      setChainData(null);
    } finally {
      setLoading(false);
    }
  };

  const filteredCalls = useMemo(() => {
    if (!chainData?.calls) return [];
    return chainData.calls
      .filter((call: any) => (call.openInterest ?? 0) > 0)
      .slice(0, 25);
  }, [chainData]);

  const filteredPuts = useMemo(() => {
    if (!chainData?.puts) return [];
    return chainData.puts
      .filter((put: any) => (put.openInterest ?? 0) > 0)
      .slice(0, 25);
  }, [chainData]);

  const handleCreateFromOption = (
    optionType: 'CALL' | 'PUT',
    leg: any,
    side: 'BUY' | 'SELL',
    price: number
  ) => {
    if (!onCreateOrderFromOption || !chainData?.symbol) return;
    if (!price || !Number.isFinite(price)) return;

    onCreateOrderFromOption({
      symbol: chainData.symbol,
      optionType,
      strikePrice: leg.strikePrice,
      expirationDate: leg.expirationDate,
      side,
      price,
    });
  };

  const rows = useMemo(() => {
    const byStrike: Record<
      number,
      {
        call?: any;
        put?: any;
      }
    > = {};

    filteredCalls.forEach((call: any) => {
      const key = Number(call.strikePrice);
      if (!byStrike[key]) byStrike[key] = {};
      byStrike[key].call = call;
    });

    filteredPuts.forEach((put: any) => {
      const key = Number(put.strikePrice);
      if (!byStrike[key]) byStrike[key] = {};
      byStrike[key].put = put;
    });

    return Object.entries(byStrike)
      .map(([strike, legs]) => ({
        strike: Number(strike),
        call: legs.call,
        put: legs.put,
      }))
      .sort((a, b) => a.strike - b.strike);
  }, [filteredCalls, filteredPuts]);

  return (
    <div>
      <h2 className="text-xl font-semibold text-white mb-6">Options Chain Viewer</h2>

      {/* TODO: Add an open interest chart visualization at the top of the options chain view. */}

      <form onSubmit={handleSearch} className="bg-slate-800 rounded-lg p-4 mb-6">
        <div className="flex gap-4">
          <div className="flex-1">
            <input
              type="text"
              placeholder="Symbol (e.g., AAPL)"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              className="w-full px-4 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex-1">
            <input
              type="date"
              placeholder="Expiration Date (optional)"
              value={expirationDate}
              onChange={(e) => setExpirationDate(e.target.value)}
              className="w-full px-4 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !symbol}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 text-white rounded-lg transition-colors"
          >
            {loading ? 'Loading...' : 'Search'}
          </button>
        </div>
      </form>

      {error && (
        <div className="mb-4 p-4 bg-red-500/20 border border-red-500 rounded-lg text-red-400">
          {error}
        </div>
      )}

      {chainData && (
        <div className="space-y-6">
          <div className="bg-slate-800 rounded-lg p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-white">{chainData.symbol}</h3>
                {activeExpiry && (
                  <div className="text-xs text-slate-400 mt-1">
                    Viewing expiry:{' '}
                    <span className="font-medium text-slate-200">{activeExpiry}</span>
                  </div>
                )}
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold text-green-400">
                  ${chainData.underlyingPrice?.toFixed(2)}
                </div>
              </div>
            </div>
          </div>

          {chainData.expirationDates && chainData.expirationDates.length > 0 && (
            <div className="bg-slate-800 rounded-lg p-4">
              <h4 className="text-sm font-medium text-slate-400 mb-2">Expiration Dates</h4>
              <div className="flex flex-wrap gap-2">
                {chainData.expirationDates.map((date: string) => (
                  <span
                    key={date}
                    className="px-3 py-1 bg-slate-700 text-slate-300 rounded-lg text-sm"
                  >
                    {date}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="bg-slate-800 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold text-slate-300">Options Chain</h4>
              <span className="text-xs text-slate-500">
                Showing strikes with open interest &gt; 0
              </span>
            </div>

            <div className="hidden md:grid md:grid-cols-[1fr,1fr,1fr] text-xs font-semibold text-slate-400 border-b border-slate-700 pb-2 mb-2">
              <div className="text-left">Call</div>
              <div className="text-center">Strike</div>
              <div className="text-right">Put</div>
            </div>

            {rows.length === 0 ? (
              <p className="text-slate-400 text-center py-4 text-sm">
                No options with open interest &gt; 0
              </p>
            ) : (
              <div className="space-y-2 max-h-[540px] overflow-y-auto pr-1">
                {rows.map((row) => {
                  const call = row.call;
                  const put = row.put;

                  return (
                    <div
                      key={row.strike}
                      className="grid grid-cols-1 md:grid-cols-[1fr,auto,1fr] gap-2 md:gap-4 items-stretch bg-slate-900/40 rounded-lg p-3 border border-slate-800"
                    >
                      {/* Call side (left) */}
                      <div className="flex flex-col gap-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[11px] uppercase tracking-wide text-green-400">
                            Call
                          </span>
                          <span className="text-xs text-slate-400">
                            OI:{' '}
                            {call
                              ? call.openInterest?.toLocaleString?.() ?? call.openInterest
                              : '—'}
                          </span>
                        </div>
                        <div className="text-xs text-slate-400">
                          {call ? `Exp: ${call.expirationDate}` : '—'}
                        </div>
                        {call && (
                          <div className="mt-1 flex flex-col items-end gap-1">
                            <div className="text-xs text-green-400 font-semibold">
                              Last {call.last != null ? `$${call.last.toFixed(2)}` : '—'}
                            </div>
                            <div className="flex flex-wrap gap-1 justify-end">
                              <button
                                type="button"
                                disabled={!call.bid}
                                onClick={() =>
                                  handleCreateFromOption('CALL', call, 'SELL', call.bid)
                                }
                                className="px-2 py-1 text-[11px] rounded bg-slate-800/80 hover:bg-green-700/70 disabled:opacity-40 text-slate-100 border border-slate-600"
                              >
                                Sell Bid {call.bid ? `$${call.bid.toFixed(2)}` : ''}
                              </button>
                              <button
                                type="button"
                                disabled={!call.ask}
                                onClick={() =>
                                  handleCreateFromOption('CALL', call, 'SELL', call.ask)
                                }
                                className="px-2 py-1 text-[11px] rounded bg-slate-800/80 hover:bg-green-700/70 disabled:opacity-40 text-slate-100 border border-slate-600"
                              >
                                Sell Ask {call.ask ? `$${call.ask.toFixed(2)}` : ''}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Strike (center) */}
                      <div className="flex flex-col items-center justify-center text-sm font-semibold text-slate-200">
                        <div>${row.strike.toFixed(2)}</div>
                      </div>

                      {/* Put side (right) */}
                      <div className="flex flex-col gap-1 items-end text-right">
                        <div className="flex items-baseline justify-between gap-2 w-full">
                          <span className="text-xs text-slate-400">
                            OI:{' '}
                            {put
                              ? put.openInterest?.toLocaleString?.() ?? put.openInterest
                              : '—'}
                          </span>
                          <span className="text-[11px] uppercase tracking-wide text-red-400">
                            Put
                          </span>
                        </div>
                        <div className="text-xs text-slate-400">
                          {put ? `Exp: ${put.expirationDate}` : '—'}
                        </div>
                        {put && (
                          <div className="mt-1 flex flex-col items-end gap-1">
                            <div className="text-xs text-red-400 font-semibold">
                              Last {put.last != null ? `$${put.last.toFixed(2)}` : '—'}
                            </div>
                            <div className="flex flex-wrap gap-1 justify-end">
                              <button
                                type="button"
                                disabled={!put.bid}
                                onClick={() =>
                                  handleCreateFromOption('PUT', put, 'BUY', put.bid)
                                }
                                className="px-2 py-1 text-[11px] rounded bg-slate-800/80 hover:bg-red-700/70 disabled:opacity-40 text-slate-100 border border-slate-600"
                              >
                                Buy Bid {put.bid ? `$${put.bid.toFixed(2)}` : ''}
                              </button>
                              <button
                                type="button"
                                disabled={!put.ask}
                                onClick={() =>
                                  handleCreateFromOption('PUT', put, 'BUY', put.ask)
                                }
                                className="px-2 py-1 text-[11px] rounded bg-slate-800/80 hover:bg-red-700/70 disabled:opacity-40 text-slate-100 border border-slate-600"
                              >
                                Buy Ask {put.ask ? `$${put.ask.toFixed(2)}` : ''}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
