import React, { useState } from 'react';
import OrderList from './components/OrderList';
import OrderForm from './components/OrderForm';
import OptionsChain from './components/OptionsChain';
import ExpiredOrders from './components/ExpiredOrders';

type Tab = 'orders' | 'create' | 'options' | 'expired';

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('orders');
  const [orderDraft, setOrderDraft] = useState<Partial<{
    symbol: string;
    action: string;
    orderType: string;
    quantity: number;
    limitPrice: string;
    notes: string;
  }>>({});

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
      action: side,
      orderType: 'LIMIT',
      quantity: prev.quantity ?? 1,
      limitPrice: price.toFixed(2),
      notes: `From options chain: ${optionType} ${strikePrice} @ ${expirationDate}${
        prev.notes ? `\n${prev.notes}` : ''
      }`,
    }));

    setActiveTab('create');
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
        {activeTab === 'create' && <OrderForm draft={orderDraft} />}
        {activeTab === 'options' && (
          <OptionsChain onCreateOrderFromOption={handlePrefillFromOption} />
        )}
        {activeTab === 'expired' && <ExpiredOrders />}
      </main>
    </div>
  );
}

export default App;
