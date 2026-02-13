export type OrderDuration = 'DAY' | 'GTC' | 'FILL_OR_KILL' | 'IMMEDIATE_OR_CANCEL';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT' | 'THRESHOLD';
export type ThresholdPriceSource = 'BID' | 'ASK' | 'LAST';
export type OrderAction = 'BUY' | 'SELL' | 'BUY_TO_COVER' | 'SELL_SHORT';
export type OrderStatus = 'PENDING' | 'SCHEDULED' | 'SUBMITTED' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED' | 'REJECTED' | 'EXPIRED' | 'PAUSED' | 'DELETED';
export type SecurityType = 'EQUITY' | 'OPTION' | 'MUTUAL_FUND' | 'MONEY_MARKET_FUND';
export type OptionType = 'CALL' | 'PUT';
export type SessionTime = 'MARKET' | 'EXTENDED';
export type ScheduleFrequency = 'DAILY' | 'WEEKLY';

export interface Order {
  id: string;
  accountId: string;
  symbol: string;
  securityType: SecurityType;

  // Option-specific fields
  optionSymbol?: string;
  optionType?: OptionType;
  strikePrice?: number;
  expirationDate?: Date;

  // Order details
  action: OrderAction;
  orderType: OrderType;
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;

  // Duration and scheduling
  preferredDuration: OrderDuration; // What user wants (e.g., GTC)
  actualDuration: OrderDuration;     // What gets placed (e.g., DAY)
  requiresDaily: boolean;            // Back-compat: derived from scheduleFrequency
  sessionTime: SessionTime;          // MARKET (9:30) or EXTENDED (7:00)

  // Scheduling
  scheduledFor?: Date;
  scheduleEnabled: boolean;
  scheduleFrequency: ScheduleFrequency;
  /** When true, order runs once at scheduledFor and is never rescheduled (e.g. "run at 2:45 today only"). */
  scheduleOnce?: boolean;

  // Status tracking
  status: OrderStatus;
  etradeOrderId?: string;
  submittedAt?: Date;
  filledAt?: Date;
  cancelledAt?: Date;
  expiresAt?: Date;

  // Error tracking
  lastError?: string;
  retryCount: number;
  maxRetries: number;

  // Threshold order fields
  thresholdEnabled?: boolean;
  thresholdPrice?: number;
  thresholdPriceSource?: ThresholdPriceSource;
  thresholdQuantity?: number;
  thresholdPollIntervalMs?: number;
  thresholdLogFile?: string;
  sellOrderEnabled?: boolean;
  sellOrderThresholdPrice?: number;
  sellOrderThresholdPriceSource?: ThresholdPriceSource;
  sellOrderQuantity?: number;
  sellOrderTriggeredByOrderId?: string;

  // Metadata
  createdAt: Date;
  updatedAt: Date;
  notes?: string;
}

export interface ScheduledOrder {
  orderId: string;
  scheduledTime: Date;
  sessionTime: SessionTime;
  locked: boolean;
  lockedBy?: string;
  lockedAt?: Date;
}

export interface OptionsChainRequest {
  symbol: string;
  expirationDate?: string;
  strikePrice?: number;
  optionType?: OptionType;
}

export interface OptionContract {
  symbol: string;
  optionType: OptionType;
  strikePrice: number;
  expirationDate: string;
  bid: number;
  ask: number;
  last: number;
  volume: number;
  openInterest: number;
  impliedVolatility?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  inTheMoney: boolean;
}

export interface OptionsChain {
  symbol: string;
  underlyingPrice: number;
  expirationDates: string[];
  strikes: number[];
  calls: OptionContract[];
  puts: OptionContract[];
}
