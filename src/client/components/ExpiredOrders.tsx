import React, { useEffect, useState } from 'react';
import { fetchExpiredOrders, resendOrder, type Order } from '../utils/api';

type Toast = { id: number; message: string; type: 'success' | 'error' };
let toastId = 0;

export default function ExpiredOrders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [resending, setResending] = useState<string | null>(null);
  const [confirmResendId, setConfirmResendId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = (message: string, type: 'success' | 'error') => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  };

  const loadExpiredOrders = async () => {
    try {
      setLoading(true);
      const data = await fetchExpiredOrders(100);
      setOrders(data);
    } catch (error) {
      console.error('Failed to load expired orders:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadExpiredOrders();
  }, []);

  const handleResend = async (orderId: string) => {
    try {
      setResending(orderId);
      await resendOrder(orderId);
      showToast('Order resent successfully', 'success');
      await loadExpiredOrders();
    } catch (error) {
      console.error('Failed to resend order:', error);
      showToast('Failed to resend order', 'error');
    } finally {
      setResending(null);
    }
  };

  const handleConfirmResend = () => {
    if (!confirmResendId) return;
    handleResend(confirmResendId);
    setConfirmResendId(null);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="flex items-center gap-3 text-slate-400">
          <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          Loading expired orders...
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Toast notifications */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`px-4 py-3 rounded-lg shadow-lg text-sm font-medium ${
              toast.type === 'success'
                ? 'bg-green-600 text-white'
                : 'bg-red-600 text-white'
            }`}
            style={{ animation: 'slideIn 0.3s ease-out' }}
          >
            {toast.message}
          </div>
        ))}
      </div>

      {/* Inline confirmation dialog */}
      {confirmResendId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-slate-800 border border-slate-600 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl">
            <h3 className="text-white font-semibold text-lg mb-2">Resend order?</h3>
            <p className="text-slate-400 text-sm mb-5">
              This will create a new order from the expired one and submit it.
            </p>
            <div className="flex gap-3">
              <button
                onClick={handleConfirmResend}
                className="flex-1 py-2.5 rounded-lg font-medium text-sm bg-green-600 hover:bg-green-700 text-white transition-colors"
              >
                Resend
              </button>
              <button
                onClick={() => setConfirmResendId(null)}
                className="flex-1 py-2.5 rounded-lg font-medium text-sm bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-white">Expired Orders</h2>
        <button
          onClick={loadExpiredOrders}
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg transition-colors text-sm font-medium"
        >
          Refresh
        </button>
      </div>

      {orders.length === 0 ? (
        <div className="text-center py-16 bg-slate-800/50 rounded-xl border border-slate-700/50">
          <svg className="w-12 h-12 mx-auto text-slate-600 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-slate-500 text-sm">No expired orders found</p>
        </div>
      ) : (
        <div className="space-y-3">
          {orders.map((order) => (
            <div
              key={order.id}
              className="bg-slate-800/80 rounded-xl p-4 border border-slate-700/50"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="text-lg font-bold text-white tracking-tight">{order.symbol}</h3>
                    <span className="px-2 py-0.5 text-xs rounded-md bg-orange-500/20 text-orange-400 border border-orange-500/30 font-medium">
                      EXPIRED
                    </span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1.5 text-sm">
                    <div>
                      <span className="text-slate-500">Action:</span>{' '}
                      <span className={order.action === 'BUY' || order.action === 'BUY_TO_COVER' ? 'text-green-400' : 'text-red-400'}>
                        {order.action}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500">Type:</span>{' '}
                      <span className="text-slate-300">{order.orderType}</span>
                    </div>
                    <div>
                      <span className="text-slate-500">Qty:</span>{' '}
                      <span className="text-slate-300">{order.quantity}</span>
                    </div>
                    {order.limitPrice && (
                      <div>
                        <span className="text-slate-500">Limit:</span>{' '}
                        <span className="text-slate-300">${order.limitPrice}</span>
                      </div>
                    )}
                    {order.expiresAt && (
                      <div className="col-span-2">
                        <span className="text-slate-500">Expired:</span>{' '}
                        <span className="text-slate-300">{new Date(order.expiresAt).toLocaleString()}</span>
                      </div>
                    )}
                  </div>
                  {order.notes && (
                    <div className="mt-2 text-sm text-slate-400">
                      <span className="text-slate-500">Notes:</span> {order.notes}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => setConfirmResendId(order.id)}
                  disabled={resending === order.id}
                  className="ml-4 px-4 py-2 bg-green-600/20 hover:bg-green-600/30 disabled:bg-slate-600 text-green-400 rounded-lg transition-colors text-sm font-medium"
                >
                  {resending === order.id ? 'Resending...' : 'Resend'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
