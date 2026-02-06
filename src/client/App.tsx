import React, { useState, useEffect, useRef } from 'react';
import OrderList from './components/OrderList';
import OrderForm from './components/OrderForm';
import OptionsChain from './components/OptionsChain';
import ExpiredOrders from './components/ExpiredOrders';
import PositionsCushion from './components/PositionsCushion';
import {
  loadOrderHistory,
  addToOrderHistory,
  removeFromOrderHistory,
  getHistoryItemLabel,
  type OrderHistoryItem,
  type OrderHistoryDraft,
} from './utils/orderHistory';

type Tab = 'orders' | 'create' | 'options' | 'positions' | 'expired';

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('orders');
  const [orderHistory, setOrderHistory] = useState<OrderHistoryItem[]>([]);
  const [orderDraft, setOrderDraft] = useState<OrderHistoryDraft | undefined>(undefined);
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const historyMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOrderHistory(loadOrderHistory());
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (historyMenuRef.current && !historyMenuRef.current.contains(e.target as Node)) {
        setHistoryMenuOpen(false);
      }
    };
    if (historyMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [historyMenuOpen]);

  const handlePrefillFromOption = (params: {
    symbol: string;
    optionType: 'CALL' | 'PUT';
    strikePrice: number;
    expirationDate: string;
    side: 'BUY' | 'SELL';
    price: number;
  }) => {
    const { symbol, optionType, strikePrice, expirationDate, side, price } = params;

    setOrderDraft((prev) => ({
      ...prev,
      symbol,
      securityType: 'OPTION',
      optionType,
      strikePrice,
      expirationDate,
      action: side,
      orderType: 'LIMIT',
      quantity: prev?.quantity ?? 1,
      limitPrice: price.toFixed(2),
      notes: `From options: ${optionType} ${strikePrice} @ ${expirationDate}${
        prev?.notes ? `\n${prev.notes}` : ''
      }`,
    }));

    setActiveTab('create');
  };

  const handleOrderCreated = (draft: OrderHistoryDraft) => {
    setOrderHistory(addToOrderHistory(draft));
    setOrderDraft(undefined);
  };

  const handleSelectHistoryItem = (item: OrderHistoryItem) => {
    setOrderDraft(item.draft);
    setHistoryMenuOpen(false);
    setActiveTab('create');
  };

  const handleRemoveHistoryItem = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setOrderHistory(removeFromOrderHistory(id));
  };

  return (
    <div className="min-h-screen bg-slate-900">
      <header className="bg-slate-800 border-b border-slate-700">
        <div className="container mx-auto px-4 py-4">
          <h1 className="text-2xl font-bold text-white">E*TRADE Trade Placer</h1>
          <p className="text-slate-400 text-sm mt-1">Automated daily trading system</p>
        </div>
      </header>

      <nav className="bg-slate-800 border-b border-slate-700">
        <div className="container mx-auto px-4">
          <div className="flex space-x-1">
            {[
              { id: 'orders', label: 'Active Orders' },
              { id: 'create', label: 'Create Order' },
              { id: 'options', label: 'Options Chain' },
              { id: 'positions', label: 'Trade Ideas (Max Pain)' },
              { id: 'expired', label: 'Expired Orders' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as Tab)}
                className={`px-4 py-3 font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'text-blue-400 border-b-2 border-blue-400'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </nav>

      <main className="container mx-auto px-4 py-6">
        {activeTab === 'orders' && <OrderList />}
        {activeTab === 'create' && (
          <div className="w-full max-w-md mx-auto">
            {orderHistory.length > 0 && (
              <div className="relative mb-4 px-2" ref={historyMenuRef}>
                <button
                  type="button"
                  onClick={() => setHistoryMenuOpen((v) => !v)}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-slate-300 text-sm hover:bg-slate-700 hover:text-white transition-colors"
                >
                  <span>Recent orders</span>
                  <span className="text-slate-500">({orderHistory.length})</span>
                  <svg
                    className={`w-4 h-4 transition-transform ${historyMenuOpen ? 'rotate-180' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {historyMenuOpen && (
                  <div className="absolute left-2 right-2 mt-1 max-h-64 overflow-auto rounded-lg bg-slate-800 border border-slate-600 shadow-lg z-20">
                    {orderHistory.map((item) => (
                      <div
                        key={item.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => handleSelectHistoryItem(item)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handleSelectHistoryItem(item);
                          }
                        }}
                        className="flex items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-slate-700 text-slate-200 text-sm border-b border-slate-700 last:border-b-0 cursor-pointer"
                      >
                        <span className="truncate flex-1 min-w-0">
                          {getHistoryItemLabel(item)}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => handleRemoveHistoryItem(e, item.id)}
                          className="shrink-0 p-1 rounded text-slate-500 hover:text-red-400 hover:bg-slate-600"
                          title="Remove from history"
                          aria-label="Remove from history"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <OrderForm draft={orderDraft} onOrderCreated={handleOrderCreated} />
          </div>
        )}
        {activeTab === 'options' && (
          <OptionsChain onCreateOrderFromOption={handlePrefillFromOption} />
        )}
        {activeTab === 'positions' && (
          <PositionsCushion onCreateOrderFromOption={handlePrefillFromOption} />
        )}
        {activeTab === 'expired' && <ExpiredOrders />}
      </main>
    </div>
  );
}

export default App;
