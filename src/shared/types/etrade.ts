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
 * Idealized quote interface for type safety.
 * 
 * **Note:** The actual E*TRADE API response has a different structure.
 * The real response nests market data inside an `All` object with different field names:
 * 
 * ```typescript
 * {
 *   dateTime: string,
 *   quoteStatus: string,
 *   All: {
 *     bid: number,
 *     ask: number,
 *     bidSize: number,
 *     askSize: number,
 *     lastTrade: number,        // Not "last"
 *     totalVolume: number,      // Not "volume"
 *     changeClose: number,      // Not "change"
 *     changeClosePercentage: number, // Not "changePct"
 *     high: number,
 *     low: number,
 *     open: number,
 *     previousClose: number,    // Not "close"
 *     // ... other fields
 *   }
 * }
 * ```
 * 
 * When working with quote data from `ETradeClient.getQuote()`, access fields via `quote.All`:
 * ```typescript
 * const quotes = await client.getQuote(['AMZN']);
 * const quoteData = quotes[0].All || quotes[0];
 * const bid = quoteData.bid;
 * const lastPrice = quoteData.lastTrade || quoteData.previousClose;
 * ```
 */
export interface ETradeQuote {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  bidSize: number;
  askSize: number;
  volume: number;
  lastTradeTime: number;
  high52: number;
  low52: number;
  open: number;
  high: number;
  low: number;
  close: number;
  change: number;
  changePct: number;
}
