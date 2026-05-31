import type { SecurityType, OptionType } from "./order.js";

/**
 * Normalized representation of a portfolio position, shared between
 * server and client. Dates are ISO strings so they can be safely
 * serialized over the wire.
 */
export interface Position {
  /** Underlying or equity symbol for the position (e.g. AAPL) */
  symbol: string;
  /** Security type for the position (e.g. EQUITY, OPTION) */
  securityType: SecurityType;
  /** Signed position quantity (shares or contracts) */
  quantity: number;

  /** Underlying symbol for option positions, if available */
  underlyingSymbol?: string;

  // Option-specific details (when securityType === 'OPTION')
  optionType?: OptionType;
  strikePrice?: number;
  /** Expiration date in ISO yyyy-mm-dd format */
  expirationDate?: string;
}

/**
 * Lightweight summary for a single option leg used in the
 * positions cushion view.
 */
export interface OptionLegSummary {
  /** OSI or option symbol identifier */
  symbol: string;
  optionType: OptionType;
  strikePrice: number;
  /** Expiration date in ISO yyyy-mm-dd format */
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

/**
 * Combined view model for the positions cushion endpoint.
 */
export interface PositionCushion {
  position: Position;
  highestOiCall?: OptionLegSummary;
  highestOiPut?: OptionLegSummary;
  underlyingQuote: UnderlyingQuoteSummary | null;
}

/**
 * Position enriched with market value data and nominal exposure,
 * used by the Portfolio tab.
 */
export interface PortfolioPosition extends Position {
  /** Dollar value of this position in the portfolio (option premium × 100, or shares × price). */
  marketValue?: number;
  /** Percent of total portfolio market value, as reported by E*TRADE. */
  pctOfPortfolio?: number;
  /** Spot price of the underlying symbol (stock price for equities, underlying for options). */
  underlyingPrice?: number;
  /**
   * Signed nominal/intrinsic value:
   *   equity  → signed_qty × underlying_price
   *   call    → signed_contracts × 100 × max(underlying_price - strike, 0)
   *   put     → signed_contracts × 100 × max(strike - underlying_price, 0)
   */
  nominalValue?: number;
}

export interface PortfolioResponse {
  accountIdKey: string;
  positions: PortfolioPosition[];
  /** Total portfolio market value (from E*TRADE totals or sum of positions). */
  totalMarketValue: number;
}
