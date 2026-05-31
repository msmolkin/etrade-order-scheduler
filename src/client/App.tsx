import React, { useState, useEffect, useRef } from "react";
import OrderList from "./components/OrderList";
import OrderForm from "./components/OrderForm";
import QuickSend from "./components/QuickSend";
import OptionsChain from "./components/OptionsChain";
import ExpiredOrders from "./components/ExpiredOrders";
import PositionsCushion from "./components/PositionsCushion";
import Portfolio from "./components/Portfolio";
import SystemStatusBar from "./components/SystemStatusBar";
import { fetchQuote } from "./utils/api";
import {
  loadOrderHistory,
  addToOrderHistory,
  removeFromOrderHistory,
  clearOrderHistory,
  getHistoryItemLabel,
  type OrderHistoryItem,
  type OrderHistoryDraft,
} from "./utils/orderHistory";

type Tab =
  | "orders"
  | "create"
  | "quicksend"
  | "options"
  | "positions"
  | "portfolio"
  | "expired";

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("orders");
  const [orderHistory, setOrderHistory] = useState<OrderHistoryItem[]>([]);
  const [orderDraft, setOrderDraft] = useState<OrderHistoryDraft | undefined>(
    undefined,
  );
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const historyMenuRef = useRef<HTMLDivElement>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const healthCheck = async () => {
    setToast({ msg: "Checking MU...", ok: true });
    try {
      const quotes = await fetchQuote(["MU"]);
      const q = quotes[0];
      const price = q?.last ?? q?.lastTrade ?? q?.bid;
      if (price != null) {
        setToast({ msg: `MU $${Number(price).toFixed(2)}`, ok: true });
      } else {
        setToast({ msg: "MU: no price returned", ok: false });
      }
    } catch (err: any) {
      setToast({ msg: err?.message ?? "Quote failed", ok: false });
    }
    setTimeout(() => setToast(null), 5000);
  };

  useEffect(() => {
    setOrderHistory(loadOrderHistory());
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        historyMenuRef.current &&
        !historyMenuRef.current.contains(e.target as Node)
      ) {
        setHistoryMenuOpen(false);
      }
    };
    if (historyMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [historyMenuOpen]);

  const handlePrefillFromOption = (params: {
    symbol: string;
    optionType: "CALL" | "PUT";
    strikePrice: number;
    expirationDate: string;
    side: "BUY" | "SELL";
    price: number;
  }) => {
    const { symbol, optionType, strikePrice, expirationDate, side, price } =
      params;

    setOrderDraft((prev) => ({
      ...prev,
      symbol,
      securityType: "OPTION",
      optionType,
      strikePrice,
      expirationDate,
      action: side,
      orderType: "LIMIT",
      quantity: prev?.quantity ?? 1,
      limitPrice: price.toFixed(2),
      notes: `From options: ${optionType} ${strikePrice} @ ${expirationDate}${
        prev?.notes ? `\n${prev.notes}` : ""
      }`,
    }));

    setActiveTab("create");
  };

  const handleOrderCreated = (draft: OrderHistoryDraft) => {
    setOrderHistory(addToOrderHistory(draft));
    setOrderDraft(undefined);
  };

  const handleSelectHistoryItem = (item: OrderHistoryItem) => {
    setOrderDraft(item.draft);
    setHistoryMenuOpen(false);
    setActiveTab("create");
  };

  const handleRemoveHistoryItem = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setOrderHistory(removeFromOrderHistory(id));
  };

  const handleClearAllHistory = (e: React.MouseEvent) => {
    e.stopPropagation();
    clearOrderHistory();
    setOrderHistory([]);
    setHistoryMenuOpen(false);
  };

  return (
    <div className="min-h-screen bg-slate-900">
      {historyMenuOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm"
          aria-hidden="true"
        />
      )}
      {/* Slice 6: SystemStatusBar + AuthFix hero (mounted in OrderList) replace the inline AuthWidget. */}
      <SystemStatusBar />

      <nav className="bg-slate-800/50 border-b border-slate-700/50 backdrop-blur-sm sticky top-0 z-30">
        <div className="container mx-auto px-4">
          <div className="flex gap-1 py-2 overflow-x-auto scrollbar-none">
            {[
              { id: "orders", label: "Active Orders" },
              { id: "create", label: "Create Order" },
              { id: "quicksend", label: "Quick Send" },
              { id: "options", label: "Options Chain" },
              { id: "positions", label: "Trade Ideas" },
              { id: "portfolio", label: "Portfolio" },
              { id: "expired", label: "Expired" },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as Tab)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${
                  activeTab === tab.id
                    ? "bg-blue-600/20 text-blue-400 shadow-sm"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-700/50"
                }`}
              >
                {tab.label}
              </button>
            ))}
            <button
              type="button"
              onClick={healthCheck}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap text-slate-500 hover:text-green-400 hover:bg-slate-700/50"
              title="Fetch MU quote to verify E*TRADE connection"
            >
              {"\u2764"}
            </button>
          </div>
        </div>
      </nav>

      <main className="container mx-auto px-4 py-6">
        {activeTab === "orders" && <OrderList />}
        {activeTab === "quicksend" && (
          <QuickSend
            orderHistory={orderHistory}
            onOrderSent={handleOrderCreated}
          />
        )}
        {activeTab === "create" && (
          <div className="w-full max-w-md mx-auto">
            {orderHistory.length > 0 && (
              <div className="relative mb-4 px-2" ref={historyMenuRef}>
                <button
                  type="button"
                  onClick={() => setHistoryMenuOpen((v) => !v)}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-slate-300 text-sm hover:bg-slate-700 hover:text-white transition-colors outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                >
                  <span>Recent orders</span>
                  <span className="text-slate-500">
                    ({orderHistory.length})
                  </span>
                  <svg
                    className={`w-4 h-4 transition-transform ${historyMenuOpen ? "rotate-180" : ""}`}
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
                    className="absolute left-2 right-2 mt-1 max-h-64 overflow-auto rounded-lg border border-slate-600 shadow-2xl shadow-black/70 z-50"
                    style={{ backgroundColor: "#020617", opacity: 1 }}
                  >
                    <div
                      className="sticky top-0 px-3 py-2 text-xs font-medium text-slate-300 border-b border-slate-700"
                      style={{ backgroundColor: "#020617" }}
                    >
                      Click an order to prefill the form. Use Delete to remove
                      one, or Clear all below.
                    </div>
                    {orderHistory.map((item) => (
                      <div
                        key={item.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => handleSelectHistoryItem(item)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handleSelectHistoryItem(item);
                          }
                        }}
                        className="flex items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-slate-800 text-slate-100 text-sm border-b border-slate-700 last:border-b-0 cursor-pointer outline-none focus-visible:bg-slate-900 focus-visible:ring-2 focus-visible:ring-blue-500"
                      >
                        <span className="truncate flex-1 min-w-0">
                          {getHistoryItemLabel(item)}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => handleRemoveHistoryItem(e, item.id)}
                          className="shrink-0 flex items-center gap-1 px-2 py-1 rounded text-slate-400 hover:text-red-400 hover:bg-slate-800 text-xs font-medium outline-none focus-visible:ring-1 focus-visible:ring-red-400"
                          title="Delete this order from history"
                          aria-label="Delete this order from history"
                        >
                          <svg
                            className="w-4 h-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            />
                          </svg>
                          <span>Delete</span>
                        </button>
                      </div>
                    ))}
                    <div
                      className="border-t border-slate-700 p-2"
                      style={{ backgroundColor: "#020617" }}
                    >
                      <button
                        type="button"
                        onClick={handleClearAllHistory}
                        className="w-full px-3 py-2 rounded text-xs font-medium text-slate-300 hover:text-red-400 hover:bg-slate-800 outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                      >
                        Clear all history
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            <OrderForm draft={orderDraft} onOrderCreated={handleOrderCreated} />
          </div>
        )}
        {activeTab === "options" && (
          <OptionsChain onCreateOrderFromOption={handlePrefillFromOption} />
        )}
        {activeTab === "positions" && (
          <PositionsCushion onCreateOrderFromOption={handlePrefillFromOption} />
        )}
        {activeTab === "portfolio" && (
          <Portfolio
            onModifyPosition={(draft) => {
              setOrderDraft(draft);
              setActiveTab("create");
            }}
          />
        )}
        {activeTab === "expired" && <ExpiredOrders />}
      </main>
      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 20,
            right: 20,
            zIndex: 9999,
            padding: "10px 16px",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 500,
            background: toast.ok ? "#1e293b" : "#7f1d1d",
            color: toast.ok ? "#4ade80" : "#fca5a5",
            border: `1px solid ${toast.ok ? "#334155" : "#991b1b"}`,
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
            fontVariantNumeric: "tabular-nums",
            animation: "slideIn 0.2s ease-out",
          }}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}

export default App;
