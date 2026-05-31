import React from 'react';
import { type PositionCushion } from '../utils/api';
import { usePositionsCushion } from '../hooks/usePositionsCushion';

interface PositionsCushionProps {
  onCreateOrderFromOption?: (params: {
    symbol: string;
    optionType: 'CALL' | 'PUT';
    strikePrice: number;
    expirationDate: string;
    side: 'BUY' | 'SELL';
    price: number;
  }) => void;
}

export default function PositionsCushion({
  onCreateOrderFromOption,
}: PositionsCushionProps) {
  const { data: cushions = [], isLoading: loading, error } = usePositionsCushion();
  const errorMsg = error ? (error as Error).message || 'Failed to load trade ideas' : '';

  const handleClickLeg = (
    legType: 'CALL' | 'PUT',
    cushion: PositionCushion,
    price: number
  ) => {
    if (!onCreateOrderFromOption) return;
    if (!price || !Number.isFinite(price)) return;

    const leg =
      legType === 'CALL'
        ? cushion.highestOiCall
        : cushion.highestOiPut;
    if (!leg) return;

    const underlying =
      cushion.position.underlyingSymbol || cushion.position.symbol;

    onCreateOrderFromOption({
      symbol: underlying,
      optionType: legType,
      strikePrice: leg.strikePrice,
      expirationDate: leg.expirationDate,
      side: 'SELL',
      price,
    });
  };

  return (
    <div>
      <h2 className="text-xl font-semibold text-white mb-6">
        Options Trade Ideas (Max Pain)
      </h2>

      {errorMsg && (
        <div className="mb-4 p-4 bg-red-500/20 border border-red-500 rounded-lg text-red-400">
          {errorMsg}
        </div>
      )}

      {loading && (
        <div className="mb-4 p-4 bg-slate-800 border border-slate-700 rounded-lg text-slate-300 text-sm">
          Loading positions and trade ideas...
        </div>
      )}

      {!loading && cushions.length === 0 && !errorMsg && (
        <p className="text-slate-400 text-sm">
          No positions found for the current account.
        </p>
      )}

      {cushions.length > 0 && (
        <div className="space-y-3">
          {cushions.map((c: PositionCushion) => {
            const underlying =
              c.position.underlyingSymbol || c.position.symbol;
            const quote = c.underlyingQuote;

            return (
              <div
                key={`${c.position.symbol}-${c.position.securityType}-${c.position.quantity}-${c.position.expirationDate ?? 'na'}-${c.position.strikePrice ?? 'na'}`}
                className="bg-slate-800/80 border border-slate-700 rounded-lg p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                  <div>
                    <div className="text-sm text-slate-400 uppercase tracking-wide">
                      Position
                    </div>
                    <div className="text-lg font-semibold text-white">
                      {c.position.symbol}{' '}
                      <span className="text-slate-400 text-sm">
                        ({c.position.securityType})
                      </span>
                    </div>
                    <div className="text-xs text-slate-400 mt-1">
                      Qty: {c.position.quantity}
                      {c.position.optionType && c.position.strikePrice && c.position.expirationDate
                        ? ` • ${c.position.optionType} ${c.position.strikePrice} @ ${c.position.expirationDate}`
                        : ''}
                    </div>
                  </div>

                  <div className="text-right">
                    <div className="text-xs text-slate-400">
                      Underlying: {underlying}
                    </div>
                    {quote ? (
                      <div className="mt-1 text-sm text-slate-200">
                        <span className="mr-2">
                          Bid{' '}
                          <span className="font-semibold text-green-400">
                            ${quote.bid.toFixed(2)}
                          </span>
                        </span>
                        <span className="mr-2">
                          Ask{' '}
                          <span className="font-semibold text-red-400">
                            ${quote.ask.toFixed(2)}
                          </span>
                        </span>
                        <span>
                          Last{' '}
                          <span className="font-semibold text-slate-100">
                            ${quote.last.toFixed(2)}
                          </span>
                        </span>
                      </div>
                    ) : (
                      <div className="mt-1 text-xs text-slate-500">
                        No quote available
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="border border-slate-700 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-green-400">
                        Highest OI Call
                      </span>
                      <span className="text-xs text-slate-400">
                        {c.highestOiCall
                          ? `OI ${c.highestOiCall.openInterest.toLocaleString()}`
                          : '—'}
                      </span>
                    </div>

                    {c.highestOiCall ? (
                      <>
                        <div className="text-xs text-slate-300 mb-2">
                          {c.highestOiCall.optionType}{' '}
                          {c.highestOiCall.strikePrice} @{' '}
                          {c.highestOiCall.expirationDate}
                        </div>
                        <div className="flex flex-wrap gap-2 text-xs items-center">
                          <span className="text-slate-300">
                            Bid{' '}
                            <span className="font-semibold text-green-400">
                              ${c.highestOiCall.bid.toFixed(2)}
                            </span>
                          </span>
                          <span className="text-slate-300">
                            Ask{' '}
                            <span className="font-semibold text-red-400">
                              ${c.highestOiCall.ask.toFixed(2)}
                            </span>
                          </span>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={!c.highestOiCall.bid}
                            onClick={() =>
                              handleClickLeg(
                                'CALL',
                                c,
                                c.highestOiCall!.bid
                              )
                            }
                            className="px-3 py-1.5 text-xs rounded bg-slate-900/80 hover:bg-green-700/80 disabled:opacity-40 text-slate-100 border border-slate-600"
                          >
                            Sell Call Bid $
                            {c.highestOiCall.bid.toFixed(2)}
                          </button>
                          <button
                            type="button"
                            disabled={!c.highestOiCall.ask}
                            onClick={() =>
                              handleClickLeg(
                                'CALL',
                                c,
                                c.highestOiCall!.ask
                              )
                            }
                            className="px-3 py-1.5 text-xs rounded bg-slate-900/80 hover:bg-green-700/80 disabled:opacity-40 text-slate-100 border border-slate-600"
                          >
                            Sell Call Ask $
                            {c.highestOiCall.ask.toFixed(2)}
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="text-xs text-slate-500">
                        No call options with open interest.
                      </div>
                    )}
                  </div>

                  <div className="border border-slate-700 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-red-400">
                        Highest OI Put
                      </span>
                      <span className="text-xs text-slate-400">
                        {c.highestOiPut
                          ? `OI ${c.highestOiPut.openInterest.toLocaleString()}`
                          : '—'}
                      </span>
                    </div>

                    {c.highestOiPut ? (
                      <>
                        <div className="text-xs text-slate-300 mb-2">
                          {c.highestOiPut.optionType}{' '}
                          {c.highestOiPut.strikePrice} @{' '}
                          {c.highestOiPut.expirationDate}
                        </div>
                        <div className="flex flex-wrap gap-2 text-xs items-center">
                          <span className="text-slate-300">
                            Bid{' '}
                            <span className="font-semibold text-green-400">
                              ${c.highestOiPut.bid.toFixed(2)}
                            </span>
                          </span>
                          <span className="text-slate-300">
                            Ask{' '}
                            <span className="font-semibold text-red-400">
                              ${c.highestOiPut.ask.toFixed(2)}
                            </span>
                          </span>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={!c.highestOiPut.bid}
                            onClick={() =>
                              handleClickLeg(
                                'PUT',
                                c,
                                c.highestOiPut!.bid
                              )
                            }
                            className="px-3 py-1.5 text-xs rounded bg-slate-900/80 hover:bg-red-700/80 disabled:opacity-40 text-slate-100 border border-slate-600"
                          >
                            Sell Put Bid $
                            {c.highestOiPut.bid.toFixed(2)}
                          </button>
                          <button
                            type="button"
                            disabled={!c.highestOiPut.ask}
                            onClick={() =>
                              handleClickLeg(
                                'PUT',
                                c,
                                c.highestOiPut!.ask
                              )
                            }
                            className="px-3 py-1.5 text-xs rounded bg-slate-900/80 hover:bg-red-700/80 disabled:opacity-40 text-slate-100 border border-slate-600"
                          >
                            Sell Put Ask $
                            {c.highestOiPut.ask.toFixed(2)}
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="text-xs text-slate-500">
                        No put options with open interest.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
