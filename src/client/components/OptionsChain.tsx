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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!symbol) return;

    setError('');
    setLoading(true);

    try {
      const data = await fetchOptionsChain(symbol, expirationDate || undefined);
      setChainData(data);
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
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">{chainData.symbol}</h3>
              <div className="text-2xl font-bold text-green-400">
                ${chainData.underlyingPrice?.toFixed(2)}
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

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Calls (left) */}
            <div className="bg-slate-800 rounded-lg p-4">
              <h4 className="text-lg font-semibold text-green-400 mb-4">Calls</h4>
              <div className="space-y-2">
                {filteredCalls.length > 0 ? (
                  filteredCalls.map((call: any, idx: number) => (
                    <div
                      key={idx}
                      className="p-3 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors"
                    >
                      <div className="flex justify-between items-start gap-4">
                        <div>
                          <div className="font-medium text-white">
                            Strike: ${call.strikePrice}
                          </div>
                          <div className="text-sm text-slate-400">
                            Exp: {call.expirationDate}
                          </div>
                          <div className="text-xs text-slate-500 mt-1">
                            OI: {call.openInterest?.toLocaleString?.() ?? call.openInterest}
                          </div>
                          {call.volume != null && (
                            <div className="text-xs text-slate-500">
                              Vol: {call.volume?.toLocaleString?.() ?? call.volume}
                            </div>
                          )}
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <div className="text-green-400 font-semibold">
                            ${call.last?.toFixed(2)}
                          </div>
                          <div className="flex flex-col gap-1">
                            <button
                              type="button"
                              disabled={!call.bid}
                              onClick={() =>
                                handleCreateFromOption('CALL', call, 'SELL', call.bid)
                              }
                              className="px-2 py-1 text-xs rounded bg-slate-800/80 hover:bg-green-700/70 disabled:opacity-40 text-slate-100 border border-slate-600"
                            >
                              Bid {call.bid ? `$${call.bid.toFixed(2)}` : 'N/A'}
                            </button>
                            <button
                              type="button"
                              disabled={!call.ask}
                              onClick={() =>
                                handleCreateFromOption('CALL', call, 'SELL', call.ask)
                              }
                              className="px-2 py-1 text-xs rounded bg-slate-800/80 hover:bg-green-700/70 disabled:opacity-40 text-slate-100 border border-slate-600"
                            >
                              Ask {call.ask ? `$${call.ask.toFixed(2)}` : 'N/A'}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-slate-400 text-center py-4">
                    No calls with open interest &gt; 0
                  </p>
                )}
              </div>
            </div>

            {/* Puts (right) */}
            <div className="bg-slate-800 rounded-lg p-4">
              <h4 className="text-lg font-semibold text-red-400 mb-4">Puts</h4>
              <div className="space-y-2">
                {filteredPuts.length > 0 ? (
                  filteredPuts.map((put: any, idx: number) => (
                    <div
                      key={idx}
                      className="p-3 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors"
                    >
                      <div className="flex justify-between items-start gap-4">
                        <div>
                          <div className="font-medium text-white">
                            Strike: ${put.strikePrice}
                          </div>
                          <div className="text-sm text-slate-400">
                            Exp: {put.expirationDate}
                          </div>
                          <div className="text-xs text-slate-500 mt-1">
                            OI: {put.openInterest?.toLocaleString?.() ?? put.openInterest}
                          </div>
                          {put.volume != null && (
                            <div className="text-xs text-slate-500">
                              Vol: {put.volume?.toLocaleString?.() ?? put.volume}
                            </div>
                          )}
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <div className="text-red-400 font-semibold">
                            ${put.last?.toFixed(2)}
                          </div>
                          <div className="flex flex-col gap-1">
                            <button
                              type="button"
                              disabled={!put.bid}
                              onClick={() =>
                                handleCreateFromOption('PUT', put, 'BUY', put.bid)
                              }
                              className="px-2 py-1 text-xs rounded bg-slate-800/80 hover:bg-red-700/70 disabled:opacity-40 text-slate-100 border border-slate-600"
                            >
                              Bid {put.bid ? `$${put.bid.toFixed(2)}` : 'N/A'}
                            </button>
                            <button
                              type="button"
                              disabled={!put.ask}
                              onClick={() =>
                                handleCreateFromOption('PUT', put, 'BUY', put.ask)
                              }
                              className="px-2 py-1 text-xs rounded bg-slate-800/80 hover:bg-red-700/70 disabled:opacity-40 text-slate-100 border border-slate-600"
                            >
                              Ask {put.ask ? `$${put.ask.toFixed(2)}` : 'N/A'}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-slate-400 text-center py-4">
                    No puts with open interest &gt; 0
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
