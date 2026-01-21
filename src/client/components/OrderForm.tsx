import React, { useState } from 'react';
import { createOrder } from '../utils/api';

export default function OrderForm() {
  const [formData, setFormData] = useState({
    accountId: '',
    symbol: '',
    securityType: 'EQUITY',
    action: 'BUY',
    orderType: 'LIMIT',
    quantity: 1,
    limitPrice: '',
    stopPrice: '',
    preferredDuration: 'GTC',
    actualDuration: 'DAY',
    sessionTime: 'MARKET',
    scheduledFor: '',
    scheduleEnabled: false,
    notes: '',
  });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess(false);
    setSubmitting(true);

    try {
      const orderData = {
        ...formData,
        quantity: parseInt(formData.quantity as any),
        limitPrice: formData.limitPrice ? parseFloat(formData.limitPrice) : undefined,
        stopPrice: formData.stopPrice ? parseFloat(formData.stopPrice) : undefined,
        scheduledFor: formData.scheduledFor ? new Date(formData.scheduledFor).toISOString() : undefined,
        requiresDaily: formData.preferredDuration !== formData.actualDuration,
        status: formData.scheduleEnabled ? 'SCHEDULED' : 'PENDING',
        retryCount: 0,
        maxRetries: 3,
      };

      await createOrder(orderData);
      setSuccess(true);

      // Reset form
      setFormData({
        accountId: formData.accountId,
        symbol: '',
        securityType: 'EQUITY',
        action: 'BUY',
        orderType: 'LIMIT',
        quantity: 1,
        limitPrice: '',
        stopPrice: '',
        preferredDuration: 'GTC',
        actualDuration: 'DAY',
        sessionTime: 'MARKET',
        scheduledFor: '',
        scheduleEnabled: false,
        notes: '',
      });
    } catch (err: any) {
      setError(err.message || 'Failed to create order');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <h2 className="text-xl font-semibold text-white mb-6">Create New Order</h2>

      {error && (
        <div className="mb-4 p-4 bg-red-500/20 border border-red-500 rounded-lg text-red-400">
          {error}
        </div>
      )}

      {success && (
        <div className="mb-4 p-4 bg-green-500/20 border border-green-500 rounded-lg text-green-400">
          Order created successfully!
        </div>
      )}

      <form onSubmit={handleSubmit} className="bg-slate-800 rounded-lg p-6 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Account ID
            </label>
            <input
              type="text"
              required
              value={formData.accountId}
              onChange={(e) => setFormData({ ...formData, accountId: e.target.value })}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Symbol
            </label>
            <input
              type="text"
              required
              value={formData.symbol}
              onChange={(e) => setFormData({ ...formData, symbol: e.target.value.toUpperCase() })}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Action
            </label>
            <select
              value={formData.action}
              onChange={(e) => setFormData({ ...formData, action: e.target.value })}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            >
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
              <option value="BUY_TO_COVER">BUY TO COVER</option>
              <option value="SELL_SHORT">SELL SHORT</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Order Type
            </label>
            <select
              value={formData.orderType}
              onChange={(e) => setFormData({ ...formData, orderType: e.target.value })}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            >
              <option value="MARKET">MARKET</option>
              <option value="LIMIT">LIMIT</option>
              <option value="STOP">STOP</option>
              <option value="STOP_LIMIT">STOP LIMIT</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Quantity
            </label>
            <input
              type="number"
              required
              min="1"
              value={formData.quantity}
              onChange={(e) => setFormData({ ...formData, quantity: parseInt(e.target.value) || 1 })}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            />
          </div>

          {(formData.orderType === 'LIMIT' || formData.orderType === 'STOP_LIMIT') && (
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                Limit Price
              </label>
              <input
                type="number"
                step="0.01"
                value={formData.limitPrice}
                onChange={(e) => setFormData({ ...formData, limitPrice: e.target.value })}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
              />
            </div>
          )}

          {(formData.orderType === 'STOP' || formData.orderType === 'STOP_LIMIT') && (
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                Stop Price
              </label>
              <input
                type="number"
                step="0.01"
                value={formData.stopPrice}
                onChange={(e) => setFormData({ ...formData, stopPrice: e.target.value })}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
              />
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Preferred Duration
            </label>
            <select
              value={formData.preferredDuration}
              onChange={(e) => setFormData({ ...formData, preferredDuration: e.target.value })}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            >
              <option value="GTC">GTC (Good Till Cancel)</option>
              <option value="DAY">DAY</option>
              <option value="IMMEDIATE_OR_CANCEL">Immediate or Cancel</option>
              <option value="FILL_OR_KILL">Fill or Kill</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Actual Duration (What Gets Placed)
            </label>
            <select
              value={formData.actualDuration}
              onChange={(e) => setFormData({ ...formData, actualDuration: e.target.value })}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            >
              <option value="DAY">DAY</option>
              <option value="GTC">GTC</option>
              <option value="IMMEDIATE_OR_CANCEL">Immediate or Cancel</option>
              <option value="FILL_OR_KILL">Fill or Kill</option>
            </select>
          </div>
        </div>

        {formData.preferredDuration !== formData.actualDuration && (
          <div className="p-3 bg-amber-500/20 border border-amber-500/50 rounded-lg text-amber-400 text-sm">
            This order will be placed daily at the scheduled time since the preferred duration differs from actual duration.
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">
            Session Time
          </label>
          <select
            value={formData.sessionTime}
            onChange={(e) => setFormData({ ...formData, sessionTime: e.target.value })}
            className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
          >
            <option value="MARKET">Market Hours (9:30 AM)</option>
            <option value="EXTENDED">Extended Hours (7:00 AM)</option>
          </select>
        </div>

        <div>
          <label className="flex items-center gap-2 text-slate-300">
            <input
              type="checkbox"
              checked={formData.scheduleEnabled}
              onChange={(e) => setFormData({ ...formData, scheduleEnabled: e.target.checked })}
              className="w-4 h-4"
            />
            <span className="text-sm font-medium">Enable Scheduling</span>
          </label>
        </div>

        {formData.scheduleEnabled && (
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Schedule For
            </label>
            <input
              type="datetime-local"
              value={formData.scheduledFor}
              onChange={(e) => setFormData({ ...formData, scheduledFor: e.target.value })}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            />
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">
            Notes (Optional)
          </label>
          <textarea
            value={formData.notes}
            onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
            rows={3}
            className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 text-white font-medium rounded-lg transition-colors"
        >
          {submitting ? 'Creating...' : 'Create Order'}
        </button>
      </form>
    </div>
  );
}
