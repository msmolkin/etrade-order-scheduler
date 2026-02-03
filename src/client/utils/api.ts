const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

export interface Order {
  id: string;
  accountId: string;
  symbol: string;
  securityType: string;
  action: string;
  orderType: string;
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;
  preferredDuration: string;
  actualDuration: string;
  requiresDaily: boolean;
  sessionTime: string;
  scheduledFor?: string;
  scheduleEnabled: boolean;
  status: string;
  etradeOrderId?: string;
  submittedAt?: string;
  filledAt?: string;
  cancelledAt?: string;
  expiresAt?: string;
  lastError?: string;
  retryCount: number;
  maxRetries: number;
  createdAt: string;
  updatedAt: string;
  notes?: string;
}

export async function fetchOrders(filters?: {
  accountId?: string;
  status?: string;
  scheduleEnabled?: boolean;
}): Promise<Order[]> {
  const params = new URLSearchParams();
  if (filters?.accountId) params.append('accountId', filters.accountId);
  if (filters?.status) params.append('status', filters.status);
  if (filters?.scheduleEnabled !== undefined)
    params.append('scheduleEnabled', String(filters.scheduleEnabled));

  const response = await fetch(`${API_BASE_URL}/orders?${params}`);
  if (!response.ok) throw new Error('Failed to fetch orders');
  return response.json();
}

export async function fetchExpiredOrders(limit?: number): Promise<Order[]> {
  const params = new URLSearchParams();
  if (limit) params.append('limit', String(limit));

  const response = await fetch(`${API_BASE_URL}/orders/expired?${params}`);
  if (!response.ok) throw new Error('Failed to fetch expired orders');
  return response.json();
}

export async function createOrder(order: Partial<Order>): Promise<Order> {
  const response = await fetch(`${API_BASE_URL}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(order),
  });
  if (!response.ok) throw new Error('Failed to create order');
  return response.json();
}

export async function resendOrder(orderId: string): Promise<Order> {
  const response = await fetch(`${API_BASE_URL}/orders/${orderId}/resend`, {
    method: 'POST',
  });
  if (!response.ok) throw new Error('Failed to resend order');
  return response.json();
}

export async function deleteOrder(orderId: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/orders/${orderId}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw new Error('Failed to delete order');
}

export async function submitOrder(orderId: string): Promise<{ success: boolean; order: Order }> {
  const response = await fetch(`${API_BASE_URL}/orders/${orderId}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to submit order');
  }
  return response.json();
}

export async function fetchOptionsChain(
  symbol: string,
  expirationDate?: string
): Promise<any> {
  const params = new URLSearchParams({ symbol });
  if (expirationDate) params.append('expirationDate', expirationDate);

  const response = await fetch(`${API_BASE_URL}/orders/market/options-chain?${params}`);
  if (!response.ok) throw new Error('Failed to fetch options chain');
  return response.json();
}

export async function fetchQuote(symbols: string[]): Promise<any[]> {
  const params = new URLSearchParams({ symbols: symbols.join(',') });

  const response = await fetch(`${API_BASE_URL}/orders/market/quote?${params}`);
  if (!response.ok) throw new Error('Failed to fetch quote');
  return response.json();
}

export interface TradingAccount {
  accountIdKey: string;
  accountId: string;
  nickname: string;
  name: string;
  type: string;
  status: string;
  isDefaultFromEnv: boolean;
}

export async function fetchAccounts(): Promise<{
  accounts: TradingAccount[];
  defaultAccountIdKey: string | null;
}> {
  const response = await fetch(`${API_BASE_URL}/accounts`);
  if (!response.ok) {
    throw new Error('Failed to fetch accounts');
  }
  return response.json();
}

export interface Position {
  symbol: string;
  securityType: string;
  quantity: number;
  underlyingSymbol?: string;
  optionType?: 'CALL' | 'PUT';
  strikePrice?: number;
  expirationDate?: string;
}

export interface OptionLegSummary {
  symbol: string;
  optionType: 'CALL' | 'PUT';
  strikePrice: number;
  expirationDate: string;
  openInterest: number;
  bid: number;
  ask: number;
}

export interface UnderlyingQuoteSummary {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
}

export interface PositionCushion {
  position: Position;
  highestOiCall?: OptionLegSummary;
  highestOiPut?: OptionLegSummary;
  underlyingQuote: UnderlyingQuoteSummary | null;
}

export interface SymbolSearchResult {
  symbol: string;
  companyName: string;
  exchange: string;
  securityType: string;
}

export async function fetchPositionsCushions(
  accountIdKey?: string
): Promise<PositionCushion[]> {
  const params = new URLSearchParams();
  if (accountIdKey) params.append('accountIdKey', accountIdKey);

  const response = await fetch(
    `${API_BASE_URL}/positions/cushions?${params.toString()}`
  );
  if (!response.ok) {
    try {
      const err = await response.json();
      throw new Error(err?.error || 'Failed to fetch trade ideas');
    } catch {
      throw new Error('Failed to fetch trade ideas');
    }
  }

  const data = await response.json();
  return data.cushions ?? [];
}

export async function searchSymbols(query: string): Promise<SymbolSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length < 2) {
    return [];
  }

  const params = new URLSearchParams({ q: trimmed });
  const response = await fetch(
    `${API_BASE_URL}/symbols/search?${params.toString()}`
  );

  if (!response.ok) {
    let message = 'Failed to search symbols';
    try {
      const body = await response.json();
      if (body?.error && typeof body.error === 'string') {
        message = body.error;
      }
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  const data = await response.json();
  return data.results ?? [];
}
