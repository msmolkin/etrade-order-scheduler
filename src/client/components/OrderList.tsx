import React, { useEffect, useState } from 'react';
import { fetchOrders, deleteOrder, submitOrder, updateOrderQuantity, updateOrderLimitPrice, type Order } from '../utils/api';
import { useWebSocket } from '../hooks/useWebSocket';

type Toast = { id: number; message: string; type: 'success' | 'error' };
type ConfirmAction = {
  orderId: string;
  type: 'delete' | 'submit';
  label: string;
};

let toastId = 0;

export default function OrderList() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [modifyingId, setModifyingId] = useState<string | null>(null);
  const [modifyQuantity, setModifyQuantity] = useState<number>(1);
  const [modifyPrice, setModifyPrice] = useState<string>('');
  const [modifyingSaving, setModifyingSaving] = useState(false);
  const [filter, setFilter] = useState<'all' | 'scheduled' | 'pending' | 'submitted' | 'failed' | 'complete'>('all');
  const { isConnected, lastMessage } = useWebSocket('ws://localhost:3001/ws');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  const showToast = (message: string, type: 'success' | 'error') => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  };

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

  useEffect(() => {
    if (lastMessage?.type === 'order_update') {
      loadOrders();
    }
  }, [lastMessage]);

  const handleDelete = async (orderId: string) => {
    try {
      await deleteOrder(orderId);
      setOrders(orders.filter((o) => o.id !== orderId));
      showToast('Order deleted', 'success');
    } catch (error) {
      console.error('Failed to delete order:', error);
      showToast('Failed to delete order', 'error');
    }
  };

  const handleSubmit = async (orderId: string) => {
    try {
      setSubmittingId(orderId);
      const result = await submitOrder(orderId);
      if (result.success) {
        showToast(`Order submitted! E*TRADE ID: ${result.order.etradeOrderId || 'Pending'}`, 'success');
      } else {
        showToast(`Submission failed: ${result.order.lastError || 'Unknown error'}`, 'error');
      }
      loadOrders();
    } catch (error: any) {
      console.error('Failed to submit order:', error);
      showToast(`Failed to submit: ${error.message}`, 'error');
    } finally {
      setSubmittingId(null);
    }
  };

  const handleConfirmAction = () => {
    if (!confirmAction) return;
    if (confirmAction.type === 'delete') handleDelete(confirmAction.orderId);
    else handleSubmit(confirmAction.orderId);
    setConfirmAction(null);
  };

  const handleStartModify = (order: Order) => {
    setModifyingId(order.id);
    setModifyQuantity(order.quantity);
    setModifyPrice(order.limitPrice != null ? String(order.limitPrice) : '');
  };

  const handleCancelModify = () => {
    setModifyingId(null);
  };

  const handleSaveQuantity = async (orderId: string) => {
    try {
      setModifyingSaving(true);
      await updateOrderQuantity(orderId, modifyQuantity);
      setModifyingId(null);
      loadOrders();
      showToast('Quantity updated', 'success');
    } catch (error: any) {
      console.error('Failed to update quantity:', error);
      showToast(`Failed to update quantity: ${error.message}`, 'error');
    } finally {
      setModifyingSaving(false);
    }
  };

  const handleSavePrice = async (orderId: string) => {
    const price = parseFloat(modifyPrice);
    if (Number.isNaN(price) || price < 0) {
      showToast('Invalid price', 'error');
      return;
    }
    try {
      setModifyingSaving(true);
      await updateOrderLimitPrice(orderId, price);
      setModifyingId(null);
      loadOrders();
      showToast('Limit price updated', 'success');
    } catch (error: any) {
      console.error('Failed to update price:', error);
      showToast(`Failed to update price: ${error.message}`, 'error');
    } finally {
      setModifyingSaving(false);
    }
  };

  /** Price step: 0.0001 for penny stocks (< $1), 0.01 otherwise */
  const getPriceStep = (order: Order): string => {
    const price = order.limitPrice ?? 0;
    return price < 1 ? '0.0001' : '0.01';
  };

  const ACTIVE_STATUSES = ['PENDING', 'SCHEDULED', 'SUBMITTED'];
  const COMPLETE_STATUSES = ['FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED'];

  const filteredOrders = orders.filter((order) => {
    if (filter === 'all') return ACTIVE_STATUSES.includes(order.status) && !order.lastError;
    if (filter === 'failed') return !!order.lastError && ACTIVE_STATUSES.includes(order.status);
    if (filter === 'complete') return COMPLETE_STATUSES.includes(order.status);
    if (filter === 'scheduled') return order.status === 'SCHEDULED' && !order.lastError;
    if (filter === 'pending') return order.status === 'PENDING';
    if (filter === 'submitted') return order.status === 'SUBMITTED';
    return true;
  });

  const getStatusColor = (status: string) => {
    const colors: Record<string, string> = {
      SCHEDULED: 'bg-blue-500/20 text-blue-400 border border-blue-500/30',
      PENDING: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
      SUBMITTED: 'bg-purple-500/20 text-purple-400 border border-purple-500/30',
      FILLED: 'bg-green-500/20 text-green-400 border border-green-500/30',
      REJECTED: 'bg-red-500/20 text-red-400 border border-red-500/30',
      CANCELLED: 'bg-gray-500/20 text-gray-400 border border-gray-500/30',
      EXPIRED: 'bg-orange-500/20 text-orange-400 border border-orange-500/30',
    };
    return colors[status] || 'bg-gray-500/20 text-gray-400';
  };

  const getScheduleBadge = (order: Order): string | null => {
    if (!order.scheduleEnabled) return null;
    if (order.scheduleOnce) return 'ONCE';
    if (order.scheduleFrequency === 'WEEKLY') return 'WEEKLY';
    return 'DAILY';
  };

  const formatExpiration = (exp: string | undefined | null): string => {
    if (exp == null || exp === '') return '\u2014';
    const s = String(exp);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? '\u2014' : d.toISOString().slice(0, 10);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="flex items-center gap-3 text-slate-400">
          <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          Loading orders...
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
      {confirmAction && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
          style={{ backgroundColor: 'rgba(0,0,0,0.6)', opacity: 1 }}
        >
          <div
            className="border border-slate-600 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl"
            style={{ backgroundColor: '#1e293b', opacity: 1 }}
          >
            <h3 className="text-white font-semibold text-lg mb-2">
              {confirmAction.type === 'delete' ? 'Delete order?' : 'Submit order?'}
            </h3>
            <p className="text-slate-400 text-sm mb-5">
              {confirmAction.type === 'delete'
                ? 'This will permanently remove the order.'
                : 'This will submit the order to E*TRADE now.'}
            </p>
            <div className="flex gap-3">
              <button
                onClick={handleConfirmAction}
                className={`flex-1 py-2.5 rounded-lg font-medium text-sm transition-colors ${
                  confirmAction.type === 'delete'
                    ? 'bg-red-600 hover:bg-red-700 text-white'
                    : 'bg-green-600 hover:bg-green-700 text-white'
                }`}
              >
                {confirmAction.label}
              </button>
              <button
                onClick={() => setConfirmAction(null)}
                className="flex-1 py-2.5 rounded-lg font-medium text-sm bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-white">Active Orders</h2>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500 shadow-sm shadow-green-500/50' : 'bg-red-500'}`} />
            <span className="text-sm text-slate-500">
              {isConnected ? 'Live' : 'Offline'}
            </span>
          </div>
          <button
            onClick={loadOrders}
            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg transition-colors text-sm font-medium"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="flex gap-1.5 mb-5 flex-wrap">
        {(['all', 'scheduled', 'pending', 'submitted', 'failed', 'complete'] as const).map((f) => {
          const failedCount = orders.filter((o) => !!o.lastError && ACTIVE_STATUSES.includes(o.status)).length;
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3.5 py-1.5 rounded-lg capitalize text-sm font-medium transition-all ${
                filter === f
                  ? f === 'failed' ? 'bg-red-600 text-white shadow-sm shadow-red-600/30' : 'bg-blue-600/20 text-blue-400'
                  : f === 'failed' && failedCount > 0
                    ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
                    : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
              }`}
            >
              {f}{f === 'failed' && failedCount > 0 ? ` (${failedCount})` : ''}
            </button>
          );
        })}
      </div>

      {filteredOrders.length === 0 ? (
        <div className="text-center py-16 bg-slate-800/50 rounded-xl border border-slate-700/50">
          <svg className="w-12 h-12 mx-auto text-slate-600 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          <p className="text-slate-500 text-sm">No orders found</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredOrders.map((order) => {
            const isModifying = modifyingId === order.id;
            const priceStep = getPriceStep(order);

            return (
              <div
                key={order.id}
                className="bg-slate-800/80 rounded-xl p-4 border border-slate-700/50 hover:border-slate-600/80 transition-all"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center flex-wrap gap-x-2 gap-y-1 mb-2">
                      <h3 className="text-lg font-bold text-white tracking-tight">{order.symbol}</h3>
                      {order.securityType === 'OPTION' && (
                        <span className="px-2 py-0.5 text-xs rounded-md bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                          Option
                        </span>
                      )}
                      <span className={`px-2 py-0.5 text-xs rounded-md font-medium ${getStatusColor(order.status)}`}>
                        {order.status}
                      </span>
                      {getScheduleBadge(order) && (
                        <span className="px-2 py-0.5 text-xs rounded-md bg-amber-500/20 text-amber-400 border border-amber-500/30">
                          {getScheduleBadge(order)}
                        </span>
                      )}
                    </div>
                    {order.securityType === 'OPTION' && (
                      <div className="text-sm text-slate-300 mb-2">
                        <span className="text-slate-500">Option:</span>{' '}
                        {order.optionType ?? '\u2014'}{' '}
                        {order.strikePrice != null ? `$${order.strikePrice}` : '\u2014'} exp{' '}
                        {formatExpiration(order.expirationDate)}
                      </div>
                    )}
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
                        {isModifying ? (
                          <span className="inline-flex items-center gap-1">
                            <input
                              type="number"
                              inputMode="numeric"
                              min="1"
                              step="1"
                              value={modifyQuantity}
                              onChange={(e) => {
                                const val = parseInt(e.target.value, 10);
                                if (!Number.isNaN(val) && val >= 1) setModifyQuantity(val);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleSaveQuantity(order.id);
                                if (e.key === 'Escape') handleCancelModify();
                              }}
                              autoFocus
                              className="w-20 px-2 py-0.5 bg-slate-700 border border-blue-500 rounded text-white text-sm focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-auto [&::-webkit-inner-spin-button]:appearance-auto"
                            />
                            <button
                              onClick={() => handleSaveQuantity(order.id)}
                              disabled={modifyingSaving}
                              className="px-2 py-0.5 text-xs bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 text-white rounded transition-colors"
                            >
                              {modifyingSaving ? '...' : 'OK'}
                            </button>
                          </span>
                        ) : (
                          <span className="text-slate-300">{order.quantity}</span>
                        )}
                      </div>
                      {order.limitPrice != null && (
                        <div>
                          <span className="text-slate-500">Limit:</span>{' '}
                          {isModifying ? (
                            <span className="inline-flex items-center gap-1">
                              <input
                                type="number"
                                inputMode="decimal"
                                min="0"
                                step={priceStep}
                                value={modifyPrice}
                                onChange={(e) => setModifyPrice(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleSavePrice(order.id);
                                  if (e.key === 'Escape') handleCancelModify();
                                }}
                                className="w-24 px-2 py-0.5 bg-slate-700 border border-blue-500 rounded text-white text-sm focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-auto [&::-webkit-inner-spin-button]:appearance-auto"
                              />
                              <button
                                onClick={() => handleSavePrice(order.id)}
                                disabled={modifyingSaving}
                                className="px-2 py-0.5 text-xs bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 text-white rounded transition-colors"
                              >
                                {modifyingSaving ? '...' : 'OK'}
                              </button>
                            </span>
                          ) : (
                            <span className="text-slate-300">${order.limitPrice}</span>
                          )}
                        </div>
                      )}
                      <div>
                        <span className="text-slate-500">Term:</span>{' '}
                        <span className="text-slate-300">{order.actualDuration}</span>
                      </div>
                      <div>
                        <span className="text-slate-500">Session:</span>{' '}
                        <span className="text-slate-300">{order.sessionTime}</span>
                      </div>
                      {order.scheduledFor && (
                        <div className="col-span-2">
                          <span className="text-slate-500">Next run:</span>{' '}
                          <span className="text-slate-300">{new Date(order.scheduledFor).toLocaleString()}</span>
                        </div>
                      )}
                    </div>
                    {isModifying && (
                      <div className="mt-2">
                        <button
                          onClick={handleCancelModify}
                          className="px-2.5 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-slate-400 rounded transition-colors"
                        >
                          Cancel editing
                        </button>
                      </div>
                    )}
                    {order.lastError && (
                      <div className="mt-2 p-2.5 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
                        {order.lastError}
                      </div>
                    )}
                  </div>
                  <div className="ml-4 flex flex-col gap-2 shrink-0">
                    {(order.status === 'PENDING' || order.status === 'SCHEDULED') && (
                      <>
                        <button
                          onClick={() =>
                            setConfirmAction({ orderId: order.id, type: 'submit', label: 'Submit' })
                          }
                          disabled={submittingId === order.id}
                          className="px-3 py-1.5 text-sm bg-green-600 hover:bg-green-700 disabled:bg-green-600/50 text-white rounded-lg transition-colors font-medium"
                        >
                          {submittingId === order.id ? 'Sending...' : 'Submit'}
                        </button>
                        <button
                          onClick={() => isModifying ? handleCancelModify() : handleStartModify(order)}
                          className={`px-3 py-1.5 text-sm rounded-lg transition-colors font-medium ${
                            isModifying
                              ? 'bg-blue-600/20 text-blue-400 hover:bg-blue-600/30'
                              : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
                          }`}
                        >
                          {isModifying ? 'Done' : 'Modify'}
                        </button>
                      </>
                    )}
                    <button
                      onClick={() =>
                        setConfirmAction({ orderId: order.id, type: 'delete', label: 'Delete' })
                      }
                      className="px-3 py-1.5 text-sm bg-red-600/10 hover:bg-red-600/20 text-red-400 rounded-lg transition-colors font-medium"
                    >
                      Delete
                    </button>
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
