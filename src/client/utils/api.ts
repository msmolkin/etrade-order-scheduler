/**
 * API utility functions for interacting with the backend server for authentication,
 * orders, accounts and symbol-related data.
 *
 * --- Authentication verification (how it works) ---
 *
 * The API provides functions to check authentication status and test if the E*TRADE OAuth 
 * credentials and client connection are valid.
 *
 * 1. `fetchAuthStatus()` 
 *     - GET `/auth/status` on the server.
 *     - Returns information on whether the client is authenticated, using sandbox, and if consumer key is set.
 *     - This only reads state, it doesn't run an external test.
 *
 * 2. `fetchAuthTest()`
 *     - GET `/auth/test` on the server.
 *     - The server implementation (see `src/server/routes/auth.ts`) will attempt to:
 *         - Authorize with E*TRADE using the current OAuth tokens.
 *         - Make an actual request for accounts (typically `/v1/accounts/list`).
 *         - Confirm that the request succeeds and returns valid account data.
 *         - Returns `{ ok: true, accountsCount }` if valid, or `{ ok: false, error }` if the test fails.
 *     - This command is the actual verification of current session/OAuth state.
 *
 * 3. `fetchAuthStart()` and `postAuthVerify()` 
 *     - POST or GET to `/auth/start` or `/auth/verify`.
 *     - These endpoints are used for initiating a new OAuth handshake, not verification.
 * 
 * 4. `postAuthReloadEnv()`
 *     - Tells the server to reload the `.env` file and update its in-memory configuration.
 *     - Does NOT verify credentials by contacting E*TRADE.
 *
 * In summary: `fetchAuthTest()` is the function that actively verifies authentication with E*TRADE by executing a real API call on the server, usually fetching accounts as a connectivity/auth test.
 */

/// <reference types="vite/client" />

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

export interface AuthStatus {
  authenticated: boolean;
  sandbox: boolean;
  consumerKeySet: boolean;
}

export interface AuthTestResult {
  ok: boolean;
  accountsCount?: number;
  message?: string;
  error?: string;
}

/**
 * Get passive auth state. Just checks in-memory/in-config status on the server.
 */
export async function fetchAuthStatus(): Promise<AuthStatus> {
  const response = await fetch(`${API_BASE_URL}/auth/status`);
  if (!response.ok) throw new Error('Failed to fetch auth status');
  return response.json();
}

/**
 * Actively tests real authentication to E*TRADE by making a backend server API call,
 * which attempts an authenticated request (accounts list) to verify tokens work.
 * 
 * Returns { ok: boolean, accountsCount, error }.
 */
export async function fetchAuthTest(): Promise<AuthTestResult> {
  const response = await fetch(`${API_BASE_URL}/auth/test`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    return {
      ok: false,
      error: `Non-JSON response from auth test (${response.status}). ${text.slice(0, 120)}`,
    };
  }

  const data = await response.json();
  if (!response.ok) return { ok: false, error: data.error ?? data.message ?? 'Request failed' };
  return data;
}

/**
 * Initiates OAuth sign-in process. Does not verify. Starts new handshake.
 */
export async function fetchAuthStart(): Promise<{ success: boolean; authUrl?: string; oauth_token?: string; error?: string }> {
  const response = await fetch(`${API_BASE_URL}/auth/start`);
  const data = await response.json();
  if (!response.ok) return { success: false, error: data.error ?? 'Failed to start OAuth' };
  return data;
}

/**
 * Submits OAuth verifier code after user authorizes app on E*TRADE site.
 * Not a "test", but part of the OAuth credential setup step.
 */
export async function postAuthVerify(oauth_token: string, oauth_verifier: string): Promise<{ success: boolean; error?: string }> {
  const response = await fetch(`${API_BASE_URL}/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oauth_token, oauth_verifier }),
  });
  const data = await response.json();
  if (!response.ok) return { success: false, error: data.error ?? 'Verification failed' };
  return { success: data.success, error: data.error };
}

export async function postAuthReloadEnv(): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/auth/reload-env`, { method: 'POST' });
  if (!response.ok) throw new Error('Failed to reload env');
}

export interface Order {
  id: string;
  accountId: string;
  symbol: string;
  securityType: string;
  optionSymbol?: string;
  optionType?: 'CALL' | 'PUT';
  strikePrice?: number;
  expirationDate?: string;
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
  scheduleFrequency?: 'DAILY' | 'WEEKLY';
  scheduleOnce?: boolean;
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
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || 'Failed to create order');
  }
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

export async function fetchOptionExpirations(symbol: string): Promise<string[]> {
  const params = new URLSearchParams({ symbol });
  const response = await fetch(
    `${API_BASE_URL}/orders/market/option-expirations?${params}`
  );
  if (!response.ok) throw new Error('Failed to fetch option expirations');
  const data = await response.json();
  return data.expirationDates ?? [];
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
  const text = await response.text();
  try {
    const data = text ? JSON.parse(text) : [];
    if (!response.ok) {
      const msg = data?.error && typeof data.error === 'string' ? data.error : 'Failed to fetch quote';
      throw new Error(msg);
    }
    return Array.isArray(data) ? data : [data];
  } catch (err: any) {
    if (err instanceof SyntaxError || err.message?.includes('JSON')) {
      throw new Error(response.ok ? 'Invalid quote response' : 'Failed to fetch quote');
    }
    throw err;
  }
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

  const text = await response.text();
  let data: { results?: SymbolSearchResult[]; error?: string };
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    if (!response.ok) {
      throw new Error('Failed to search symbols');
    }
    return [];
  }

  if (!response.ok) {
    const message =
      typeof data?.error === 'string' ? data.error : 'Failed to search symbols';
    throw new Error(message);
  }

  return data.results ?? [];
}
