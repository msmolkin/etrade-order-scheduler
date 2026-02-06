import React, { useEffect, useState } from 'react';
import { fetchOrders, deleteOrder, submitOrder, type Order } from '../utils/api';
import { useWebSocket } from '../hooks/useWebSocket';

export default function OrderList() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'scheduled' | 'pending' | 'submitted'>('all');
  const { isConnected, lastMessage } = useWebSocket('ws://localhost:3001/ws');

  const loadOrders = async () => {
    try {
      setLoading(true);
      const data = await fetchOrders();
      setOrders(data);
    } catch (error) {
      console.error('Failed to load orders:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOrders();
  }, []);

  // Handle WebSocket updates
  useEffect(() => {
    if (lastMessage?.type === 'order_update') {
      loadOrders();
    }
  }, [lastMessage]);

  const handleDelete = async (orderId: string) => {
    if (!confirm('Are you sure you want to delete this order?')) return;

    try {
      await deleteOrder(orderId);
      setOrders(orders.filter((o) => o.id !== orderId));
    } catch (error) {
      console.error('Failed to delete order:', error);
      alert('Failed to delete order');
    }
  };

  const handleSubmit = async (orderId: string) => {
    if (!confirm('Submit this order to E*TRADE now?')) return;

    try {
      setSubmittingId(orderId);
      const result = await submitOrder(orderId);
      if (result.success) {
        alert(`Order submitted successfully!\nE*TRADE Order ID: ${result.order.etradeOrderId || 'Pending'}`);
      } else {
        alert(`Order submission failed: ${result.order.lastError || 'Unknown error'}`);
      }
      loadOrders();
    } catch (error: any) {
      console.error('Failed to submit order:', error);
      alert(`Failed to submit order: ${error.message}`);
    } finally {
      setSubmittingId(null);
    }
  };

  const filteredOrders = orders.filter((order) => {
    if (filter === 'all') return true;
    if (filter === 'scheduled') return order.status === 'SCHEDULED';
    if (filter === 'pending') return order.status === 'PENDING';
    if (filter === 'submitted') return order.status === 'SUBMITTED';
    return true;
  });

  const getStatusColor = (status: string) => {
    const colors: Record<string, string> = {
      SCHEDULED: 'bg-blue-500/20 text-blue-400',
      PENDING: 'bg-yellow-500/20 text-yellow-400',
      SUBMITTED: 'bg-purple-500/20 text-purple-400',
      FILLED: 'bg-green-500/20 text-green-400',
      REJECTED: 'bg-red-500/20 text-red-400',
      CANCELLED: 'bg-gray-500/20 text-gray-400',
      EXPIRED: 'bg-orange-500/20 text-orange-400',
    };
    return colors[status] || 'bg-gray-500/20 text-gray-400';
  };

  /** Normalize expiration to YYYY-MM-DD for display (handles ISO strings from API). */
  const formatExpiration = (exp: string | undefined | null): string => {
    if (exp == null || exp === '') return '—';
    const s = String(exp);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10);
  };

  if (loading) {
    return <div className="text-center py-8 text-slate-400">Loading orders...</div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-white">Active Orders</h2>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}></div>
            <span className="text-sm text-slate-400">
              {isConnected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
          <button
            onClick={loadOrders}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="flex gap-2 mb-4">
        {['all', 'scheduled', 'pending', 'submitted'].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f as any)}
            className={`px-4 py-2 rounded-lg capitalize transition-colors ${
              filter === f
                ? 'bg-blue-600 text-white'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {filteredOrders.length === 0 ? (
        <div className="text-center py-12 bg-slate-800 rounded-lg">
          <p className="text-slate-400">No orders found</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredOrders.map((order) => (
            <div
              key={order.id}
              className="bg-slate-800 rounded-lg p-4 border border-slate-700 hover:border-slate-600 transition-colors"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center flex-wrap gap-x-2 gap-y-1 mb-2">
                    <h3 className="text-lg font-semibold text-white">{order.symbol}</h3>
                    {order.securityType === 'OPTION' && (
                      <span className="px-2 py-0.5 text-xs rounded bg-indigo-500/20 text-indigo-300">
                        Option
                      </span>
                    )}
                    <span aria-hidden="true" className="text-slate-500 select-none">·</span>
                    <span className={`px-2 py-1 text-xs rounded-full ${getStatusColor(order.status)}`}>
                      {order.status}
                    </span>
                    {order.requiresDaily && (
                      <>
                        <span aria-hidden="true" className="text-slate-500 select-none">·</span>
                        <span className="px-2 py-1 text-xs rounded-full bg-amber-500/20 text-amber-400">
                          DAILY
                        </span>
                      </>
                    )}
                  </div>
                  {order.securityType === 'OPTION' && (
                    <div className="text-sm text-slate-300 mb-2">
                      <span className="text-slate-500">Option:</span>{' '}
                      {order.optionType ?? '—'}{' '}
                      {order.strikePrice != null ? `$${order.strikePrice}` : '—'} exp{' '}
                      {formatExpiration(order.expirationDate)}
                    </div>
                  )}
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
                    <div>
                      <span className="text-slate-500">Duration:</span> {order.preferredDuration} → {order.actualDuration}
                    </div>
                    <div>
                      <span className="text-slate-500">Session:</span> {order.sessionTime}
                    </div>
                    {order.scheduledFor && (
                      <div className="col-span-2">
                        <span className="text-slate-500">Scheduled:</span>{' '}
                        {new Date(order.scheduledFor).toLocaleString()}
                      </div>
                    )}
                  </div>
                  {order.lastError && (
                    <div className="mt-2 p-2 bg-red-500/10 border border-red-500/20 rounded text-xs text-red-400">
                      {order.lastError}
                    </div>
                  )}
                </div>
                <div className="ml-4 flex flex-col gap-2">
                  {(order.status === 'PENDING' || order.status === 'SCHEDULED') && (
                    <button
                      onClick={() => handleSubmit(order.id)}
                      disabled={submittingId === order.id}
                      className="px-3 py-1 text-sm bg-green-600 hover:bg-green-700 disabled:bg-green-600/50 text-white rounded transition-colors"
                    >
                      {submittingId === order.id ? 'Submitting...' : 'Submit Now'}
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(order.id)}
                    className="px-3 py-1 text-sm bg-red-600/20 hover:bg-red-600/30 text-red-400 rounded transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
