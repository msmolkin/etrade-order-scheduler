import React, { useEffect, useState } from 'react';
import {
  fetchOrders, deleteOrder, submitOrder, updateOrderQuantity, updateOrderLimitPrice,
  fetchDeletedOrders, restoreOrder, permanentlyDeleteOrder,
  pauseAllOrders, resumeAllOrders, pauseOrder, resumeOrder,
  type Order,
} from '../utils/api';
import { useWebSocket } from '../hooks/useWebSocket';

type Toast = { id: number; message: string; type: 'success' | 'error' };
type ConfirmAction = {
  orderId: string;
  type: 'delete' | 'submit' | 'permanent-delete';
  label: string;
  anchor: { top: number; left: number; height: number };
};

type FilterTab = 'all' | 'scheduled' | 'paused' | 'pending' | 'submitted' | 'failed' | 'complete' | 'deleted';

let toastId = 0;

export default function OrderList() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [deletedOrders, setDeletedOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [modifyingId, setModifyingId] = useState<string | null>(null);
  const [modifyQuantity, setModifyQuantity] = useState<number>(1);
  const [modifyPrice, setModifyPrice] = useState<string>('');
  const [modifyingSaving, setModifyingSaving] = useState(false);
  const [filter, setFilter] = useState<FilterTab>('all');
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
      const [data, deleted] = await Promise.all([
        fetchOrders(),
        fetchDeletedOrders(),
      ]);
      setOrders(data);
      setDeletedOrders(deleted);
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
      setOrders((prev) => prev.map((o) => o.id === orderId ? { ...o, status: 'DELETED' } : o));
      showToast('Order moved to Deleted', 'success');
    } catch (error) {
      console.error('Failed to delete order:', error);
      showToast('Failed to delete order', 'error');
    }
  };

  const handlePermanentDelete = async (orderId: string) => {
    try {
      await permanentlyDeleteOrder(orderId);
      setDeletedOrders((prev) => prev.filter((o) => o.id !== orderId));
      showToast('Order permanently deleted', 'success');
    } catch (error) {
      console.error('Failed to permanently delete order:', error);
      showToast('Failed to permanently delete', 'error');
    }
  };

  const handleRestore = async (orderId: string) => {
    try {
      await restoreOrder(orderId);
      loadOrders();
      showToast('Order restored', 'success');
    } catch (error) {
      console.error('Failed to restore order:', error);
      showToast('Failed to restore order', 'error');
    }
  };

  const handlePauseOrder = async (orderId: string) => {
    try {
      await pauseOrder(orderId);
      loadOrders();
      showToast('Order paused', 'success');
    } catch (error) {
      console.error('Failed to pause order:', error);
      showToast('Failed to pause order', 'error');
    }
  };

  const handleResumeOrder = async (orderId: string) => {
    try {
      await resumeOrder(orderId);
      loadOrders();
      showToast('Order resumed', 'success');
    } catch (error) {
      console.error('Failed to resume order:', error);
      showToast('Failed to resume order', 'error');
    }
  };

  const handlePauseAll = async () => {
    try {
      const result = await pauseAllOrders();
      loadOrders();
      showToast(`Paused ${result.paused} order(s)`, 'success');
    } catch (error) {
      console.error('Failed to pause all:', error);
      showToast('Failed to pause all orders', 'error');
    }
  };

  const handleResumeAll = async () => {
    try {
      const result = await resumeAllOrders();
      loadOrders();
      showToast(`Resumed ${result.resumed} order(s)`, 'success');
    } catch (error) {
      console.error('Failed to resume all:', error);
      showToast('Failed to resume all orders', 'error');
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
    else if (confirmAction.type === 'permanent-delete') handlePermanentDelete(confirmAction.orderId);
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

  const ACTIVE_STATUSES = ['PENDING', 'SCHEDULED', 'SUBMITTED', 'PAUSED'];
  const COMPLETE_STATUSES = ['FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED'];

  const filteredOrders = filter === 'deleted'
    ? deletedOrders
    : orders.filter((order) => {
        if (filter === 'all') return ACTIVE_STATUSES.includes(order.status) && !order.lastError;
        if (filter === 'failed') return !!order.lastError && ACTIVE_STATUSES.includes(order.status);
        if (filter === 'complete') return COMPLETE_STATUSES.includes(order.status);
        if (filter === 'scheduled') return order.status === 'SCHEDULED' && !order.lastError;
        if (filter === 'paused') return order.status === 'PAUSED';
        if (filter === 'pending') return order.status === 'PENDING';
        if (filter === 'submitted') return order.status === 'SUBMITTED';
        return true;
      });

  const pausedCount = orders.filter((o) => o.status === 'PAUSED').length;
  const scheduledCount = orders.filter((o) => o.status === 'SCHEDULED' && !o.lastError).length;
  const hasPausedOrders = pausedCount > 0;
  const hasScheduledOrders = scheduledCount > 0;

  const getStatusColor = (status: string) => {
    const colors: Record<string, string> = {
      SCHEDULED: 'bg-blue-500/20 text-blue-400 border border-blue-500/30',
      PENDING: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
      SUBMITTED: 'bg-purple-500/20 text-purple-400 border border-purple-500/30',
      FILLED: 'bg-green-500/20 text-green-400 border border-green-500/30',
      REJECTED: 'bg-red-500/20 text-red-400 border border-red-500/30',
      CANCELLED: 'bg-gray-500/20 text-gray-400 border border-gray-500/30',
      EXPIRED: 'bg-orange-500/20 text-orange-400 border border-orange-500/30',
      PAUSED: 'bg-amber-500/20 text-amber-400 border border-amber-500/30',
      DELETED: 'bg-slate-500/20 text-slate-400 border border-slate-500/30',
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

      {/* Inline confirmation popover */}
      {confirmAction && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => setConfirmAction(null)}
        >
          <div
            className="absolute border border-slate-600 rounded-xl p-4 shadow-2xl"
            style={{
              backgroundColor: '#1e293b',
              right: window.innerWidth - confirmAction.anchor.left + 8,
              top: confirmAction.anchor.top + confirmAction.anchor.height / 2,
              transform: 'translateY(-50%)',
              width: 200,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-white font-semibold text-sm mb-3">
              {confirmAction.type === 'delete'
                ? 'Delete order?'
                : confirmAction.type === 'permanent-delete'
                  ? 'Permanently delete?'
                  : 'Submit order?'}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmAction(null)}
                className="flex-1 py-2 rounded-lg font-medium text-sm bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmAction}
                className={`flex-1 py-2 rounded-lg font-medium text-sm transition-colors ${
                  confirmAction.type === 'delete' || confirmAction.type === 'permanent-delete'
                    ? 'bg-red-600 hover:bg-red-700 text-white'
                    : 'bg-green-600 hover:bg-green-700 text-white'
                }`}
              >
                {confirmAction.label}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-white">Active Orders</h2>
        <div className="flex items-center gap-4">
          {/* Pause All / Resume All toggle */}
          {(hasScheduledOrders || hasPausedOrders) && (
            <button
              onClick={hasPausedOrders ? handleResumeAll : handlePauseAll}
              className={`px-4 py-2 rounded-lg transition-colors text-sm font-medium ${
                hasPausedOrders
                  ? 'bg-green-600/20 hover:bg-green-600/30 text-green-400'
                  : 'bg-amber-600/20 hover:bg-amber-600/30 text-amber-400'
              }`}
            >
              {hasPausedOrders ? 'Resume All' : 'Pause All'}
            </button>
          )}
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
        {(['all', 'scheduled', 'paused', 'pending', 'submitted', 'failed', 'complete', 'deleted'] as const).map((f) => {
          const failedCount = orders.filter((o) => !!o.lastError && ACTIVE_STATUSES.includes(o.status)).length;
          const count =
            f === 'paused' ? pausedCount
            : f === 'deleted' ? deletedOrders.length
            : f === 'failed' ? failedCount
            : 0;
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3.5 py-1.5 rounded-lg capitalize text-sm font-medium transition-all ${
                filter === f
                  ? f === 'failed' ? 'bg-red-600 text-white shadow-sm shadow-red-600/30'
                    : f === 'paused' ? 'bg-amber-600/20 text-amber-400'
                    : f === 'deleted' ? 'bg-slate-600/20 text-slate-400'
                    : 'bg-blue-600/20 text-blue-400'
                  : f === 'failed' && failedCount > 0
                    ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
                    : f === 'paused' && pausedCount > 0
                      ? 'bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'
                      : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
              }`}
            >
              {f}{count > 0 ? ` (${count})` : ''}
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
            const isDeleted = order.status === 'DELETED';

            return (
              <div
                key={order.id}
                className={`bg-slate-800/80 rounded-xl p-4 border border-slate-700/50 hover:border-slate-600/80 transition-all ${
                  isDeleted ? 'opacity-70' : ''
                }`}
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
                    {/* Deleted order actions */}
                    {isDeleted && (
                      <>
                        <button
                          onClick={() => handleRestore(order.id)}
                          className="px-3 py-1.5 text-sm bg-green-600/20 hover:bg-green-600/30 text-green-400 rounded-lg transition-colors font-medium"
                        >
                          Restore
                        </button>
                        <button
                          onClick={(e) =>
                            setConfirmAction({ orderId: order.id, type: 'permanent-delete', label: 'Delete Forever', anchor: e.currentTarget.getBoundingClientRect() })
                          }
                          className="px-3 py-1.5 text-sm bg-red-600/10 hover:bg-red-600/20 text-red-400 rounded-lg transition-colors font-medium"
                        >
                          Delete Forever
                        </button>
                      </>
                    )}
                    {/* Active order actions */}
                    {!isDeleted && (order.status === 'PENDING' || order.status === 'SCHEDULED' || order.status === 'PAUSED') && (
                      <>
                        {order.status !== 'PAUSED' && (
                          <button
                            onClick={(e) =>
                              setConfirmAction({ orderId: order.id, type: 'submit', label: 'Submit', anchor: e.currentTarget.getBoundingClientRect() })
                            }
                            disabled={submittingId === order.id}
                            className="px-3 py-1.5 text-sm bg-green-600 hover:bg-green-700 disabled:bg-green-600/50 text-white rounded-lg transition-colors font-medium"
                          >
                            {submittingId === order.id ? 'Sending...' : 'Submit'}
                          </button>
                        )}
                        {order.status === 'SCHEDULED' && (
                          <button
                            onClick={() => handlePauseOrder(order.id)}
                            className="px-3 py-1.5 text-sm bg-amber-600/20 hover:bg-amber-600/30 text-amber-400 rounded-lg transition-colors font-medium"
                          >
                            Pause
                          </button>
                        )}
                        {order.status === 'PAUSED' && (
                          <button
                            onClick={() => handleResumeOrder(order.id)}
                            className="px-3 py-1.5 text-sm bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 rounded-lg transition-colors font-medium"
                          >
                            Resume
                          </button>
                        )}
                        {order.status !== 'PAUSED' && (
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
                        )}
                      </>
                    )}
                    {!isDeleted && (
                      <button
                        onClick={(e) =>
                          setConfirmAction({ orderId: order.id, type: 'delete', label: 'Delete', anchor: e.currentTarget.getBoundingClientRect() })
                        }
                        className="px-3 py-1.5 text-sm bg-red-600/10 hover:bg-red-600/20 text-red-400 rounded-lg transition-colors font-medium"
                      >
                        Delete
                      </button>
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
