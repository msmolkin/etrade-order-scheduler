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
  orderAction: 'BUY' | 'SELL' | 'BUY_TO_COVER' | 'SELL_SHORT';
  clientOrderId: string;
  priceType: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
  quantity: number;
  orderTerm: 'GOOD_UNTIL_CANCEL' | 'GOOD_FOR_DAY' | 'IMMEDIATE_OR_CANCEL' | 'FILL_OR_KILL';
  marketSession: 'REGULAR' | 'EXTENDED';
  stopPrice?: number;
  limitPrice?: number;
  allOrNone?: boolean;
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
