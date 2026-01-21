import React, { useEffect, useState } from 'react';
import { fetchExpiredOrders, resendOrder, type Order } from '../utils/api';

export default function ExpiredOrders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [resending, setResending] = useState<string | null>(null);

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
    if (!confirm('Resend this order?')) return;

    try {
      setResending(orderId);
      await resendOrder(orderId);
      alert('Order resent successfully!');
      await loadExpiredOrders();
    } catch (error) {
      console.error('Failed to resend order:', error);
      alert('Failed to resend order');
    } finally {
      setResending(null);
    }
  };

  if (loading) {
    return <div className="text-center py-8 text-slate-400">Loading expired orders...</div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-white">Expired Orders</h2>
        <button
          onClick={loadExpiredOrders}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
        >
          Refresh
        </button>
      </div>

      {orders.length === 0 ? (
        <div className="text-center py-12 bg-slate-800 rounded-lg">
          <p className="text-slate-400">No expired orders found</p>
        </div>
      ) : (
        <div className="space-y-3">
          {orders.map((order) => (
            <div
              key={order.id}
              className="bg-slate-800 rounded-lg p-4 border border-slate-700"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="text-lg font-semibold text-white">{order.symbol}</h3>
                    <span className="px-2 py-1 text-xs rounded-full bg-orange-500/20 text-orange-400">
                      EXPIRED
                    </span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm text-slate-400">
                    <div>
                      <span className="text-slate-500">Action:</span> {order.action}
                    </div>
                    <div>
                      <span className="text-slate-500">Type:</span> {order.orderType}
                    </div>
                    <div>
                      <span className="text-slate-500">Quantity:</span> {order.quantity}
                    </div>
                    {order.limitPrice && (
                      <div>
                        <span className="text-slate-500">Limit:</span> ${order.limitPrice}
                      </div>
                    )}
                    {order.expiresAt && (
                      <div className="col-span-2">
                        <span className="text-slate-500">Expired At:</span>{' '}
                        {new Date(order.expiresAt).toLocaleString()}
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
                  onClick={() => handleResend(order.id)}
                  disabled={resending === order.id}
                  className="ml-4 px-4 py-2 bg-green-600/20 hover:bg-green-600/30 disabled:bg-slate-600 text-green-400 rounded transition-colors"
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
