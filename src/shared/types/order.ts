export type OrderDuration =
  | "DAY"
  | "GTC"
  | "FILL_OR_KILL"
  | "IMMEDIATE_OR_CANCEL";
export type OrderType =
  | "MARKET"
  | "LIMIT"
  | "STOP"
  | "STOP_LIMIT"
  | "THRESHOLD";
export type ThresholdPriceSource = "BID" | "ASK" | "LAST";
export type OrderAction = "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
export type OrderStatus =
  | "PENDING"
  | "SCHEDULED"
  | "SUBMITTED"
  | "FILLED"
  | "PARTIALLY_FILLED"
  | "CANCELLED"
  | "REJECTED"
  | "EXPIRED"
  | "PAUSED"
  | "DELETED";
export type SecurityType =
  | "EQUITY"
  | "OPTION"
  | "MUTUAL_FUND"
  | "MONEY_MARKET_FUND";
export type OptionType = "CALL" | "PUT";
export type SessionTime = "MARKET" | "EXTENDED";
export type ScheduleFrequency = "DAILY" | "WEEKLY";

export interface Order {
  id: string;
  parentId: string;
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
  actualDuration: OrderDuration; // What gets placed (e.g., DAY)
  requiresDaily: boolean; // Back-compat: derived from scheduleFrequency
  sessionTime: SessionTime; // MARKET (9:30) or EXTENDED (7:00)

  // Scheduling
  scheduledFor?: Date;
  scheduleEnabled: boolean;
  scheduleFrequency: ScheduleFrequency;
  /** When true, order runs once at scheduledFor and is never rescheduled (e.g. "run at 2:45 today only"). */
  scheduleOnce?: boolean;
  /**
   * When true (default), and the placement actually fills at E*TRADE, future
   * scheduled clones in the same lineage are cancelled. Partial fills cause
   * the next clone's quantity to drop to (ordered - filled). Set false for
   * pure recurring DCA-style orders that should fire fresh every session.
   */
  onlyFillOnce: boolean;

  // Status tracking
  status: OrderStatus;
  etradeOrderId?: string;
  submittedAt?: Date;
  filledAt?: Date;
  cancelledAt?: Date;
  expiresAt?: Date;
  /** Shares actually executed at E*TRADE; populated by verifyOrderStatus. */
  filledQuantity?: number;

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

  // Lineage rollup (populated by getActiveOrdersWithLineage; absent on standard fetches)
  /** Symbol of the parent recurring template, when this row is a clone. */
  parentSymbol?: string | null;
  /** Number of children that share this row's id as their parent_id. */
  lineageCount?: number;
  /** Most recent FILLED filled_at across the lineage; null when none filled. */
  lastFillAt?: Date | null;
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
