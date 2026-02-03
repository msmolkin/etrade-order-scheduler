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
  marketSession: 'REGULAR' | 'EXTENDED';
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
