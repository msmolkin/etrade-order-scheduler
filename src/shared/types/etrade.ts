export interface ETradeCredentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken?: string;
  accessTokenSecret?: string;
}

export interface ETradeAccount {
  accountId: string;
  accountIdKey: string;
  accountMode: string;
  accountDesc: string;
  accountName: string;
  accountType: string;
  institutionType: string;
  accountStatus: string;
  closedDate?: number;
}

export interface ETradeOrderRequest {
  accountIdKey: string;
  symbol: string;
  securityType?: 'EQ' | 'OPTN'; // EQ for equities, OPTN for options
  orderAction: 'BUY' | 'SELL' | 'BUY_TO_COVER' | 'SELL_SHORT' | 'BUY_OPEN' | 'BUY_CLOSE' | 'SELL_OPEN' | 'SELL_CLOSE';
  clientOrderId: string;
  priceType: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
  quantity: number;
  orderTerm: 'GOOD_UNTIL_CANCEL' | 'GOOD_FOR_DAY' | 'IMMEDIATE_OR_CANCEL' | 'FILL_OR_KILL';
  marketSession: 'REGULAR' | 'EXTENDED'; // There should be an option for overnight orders as well (e.g. SLV, TLT, SPY)
  stopPrice?: number;
  limitPrice?: number;
  allOrNone?: boolean;
  /** Required for options: 'CALL' or 'PUT' */
  callPut?: 'CALL' | 'PUT';
  /** Required for options: expiry and strike */
  expiryYear?: number;
  expiryMonth?: number;
  expiryDay?: number;
  strikePrice?: number;
  /** Optional: use productId from option chain (symbol = osiKey, typeCode = 'OPTION') per E*TRADE doc */
  productId?: { symbol: string; typeCode: string };
}

export interface ETradeOrderResponse {
  orderId: number;
  orderType: string;
  orderTerm: string;
  priceType: string;
  limitPrice?: number;
  stopPrice?: number;
  orderValue: number;
  status: string;
  orderDate: number;
  messages?: {
    description: string;
    code: number;
    type: string;
  }[];
}

/**
 * E*TRADE's Get Quote API returns the wrong structure: market data is nested under
 * an `All` object and uses non-standard field names (e.g. `lastTrade` not `last`,
 * `previousClose` not `close`). We do not rely on top-level bid/ask/last.
 *
 * Correct way to read quote data from `ETradeClient.getQuote()`:
 *
 *   const quotes = await client.getQuote(['AMZN']);
 *   const data = quotes[0].All ?? quotes[0];   // always use .All first
 *   const bid = data.bid;
 *   const ask = data.ask;
 *   const lastPrice = data.lastTrade ?? data.previousClose;
 *
 * Our GET /api/orders/market/quote route normalizes this and returns flat
 * { symbol, bid, ask, last, lastTrade } so the client does not need to handle All.
 */

/** Per-symbol quote row as returned by E*TRADE (market data is inside .All). */
export interface ETradeQuote {
  symbol?: string;
  dateTime?: string;
  quoteStatus?: string;
  /** Market data; E*TRADE incorrectly nests it here instead of at top level. */
  All?: ETradeQuoteAll;
}

/** Market data payload inside quote.All. Use this when reading quote.All ?? quote. */
export interface ETradeQuoteAll {
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  lastTrade?: number;
  previousClose?: number;
  totalVolume?: number;
  changeClose?: number;
  changeClosePercentage?: number;
  high?: number;
  low?: number;
  open?: number;
}
