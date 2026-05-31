import { ETradeClient } from "./etrade-client.js";
import { OrderService } from "./order-service.js";
import type {
  Order,
  OrderDuration,
  ETradeOrderRequest,
} from "../../shared/types/index.js";
import { logOrderAttempt } from "../../scheduler/logger.js";
import { broadcastAuthStatus } from "../ws-broadcast.js";

/**
 * Slice 6.3 retry policy.
 *
 * Backoff schedule used after a non-auth execution failure. The order's
 * `retry_count` indexes into the array; jitter (+0..30%) prevents
 * thundering herds when the retries pile up across many orders.
 */
const RETRY_BACKOFF_MS = [1_000, 5_000, 20_000] as const;

/** True when an E*TRADE error message looks like an auth/token problem. */
function isAuthError(message: string): boolean {
  return /oauth_problem|token_(rejected|expired)|signature_invalid|unauthorized/i.test(
    message,
  );
}

function backoffWithJitter(retryCount: number): number {
  const idx = Math.min(retryCount, RETRY_BACKOFF_MS.length - 1);
  const base = RETRY_BACKOFF_MS[idx];
  return Math.round(base * (1 + Math.random() * 0.3));
}

export class OrderExecutor {
  private onOrderFilled?: (order: Order) => Promise<void>;

  constructor(
    private etradeClient: ETradeClient,
    private orderService: OrderService,
  ) {}

  setOnOrderFilledCallback(callback: (order: Order) => Promise<void>): void {
    this.onOrderFilled = callback;
  }

  async executeOrder(order: Order, lockerId: string): Promise<boolean> {
    try {
      // Acquire lock
      const locked = await this.orderService.acquireLock(order.id, lockerId);
      if (!locked) {
        console.log(`Order ${order.id} already locked by another process`);
        return false;
      }

      console.log(`Executing order ${order.id} for ${order.symbol}`);

      // Update status to SUBMITTED
      await this.orderService.updateOrderStatus(order.id, "SUBMITTED", {
        submittedAt: new Date(),
      });

      // Prepare E*TRADE order request
      let etradeRequest = this.mapToETradeRequest(order);

      // Option orders: E*TRADE often requires productId (OSI symbol). Look up from chain when missing.
      if (
        order.securityType === "OPTION" &&
        !etradeRequest.productId &&
        order.strikePrice != null &&
        order.optionType
      ) {
        const exp = this.normalizeExpirationDate(order.expirationDate);
        if (exp && !Number.isNaN(exp.getTime())) {
          try {
            const osiKey = await this.etradeClient.getOptionOsiKey(
              order.symbol,
              exp.getFullYear(),
              exp.getMonth() + 1,
              exp.getDate(),
              order.optionType,
              order.strikePrice,
            );
            if (osiKey) {
              etradeRequest = {
                ...etradeRequest,
                productId: { symbol: osiKey, typeCode: "OPTION" },
              };
              if (process.env.ORDER_EXECUTOR_DEBUG === "true") {
                console.log(
                  "E*TRADE option: resolved productId (osiKey)",
                  osiKey,
                );
              }
            } else {
              // Fallback: construct OCC-format OSI symbol manually
              const fallbackOsi = this.buildOsiSymbol(
                order.symbol,
                exp,
                order.optionType,
                order.strikePrice,
              );
              etradeRequest = {
                ...etradeRequest,
                productId: { symbol: fallbackOsi, typeCode: "OPTION" },
              };
              console.log(
                `Order ${order.id}: chain lookup returned no match, using constructed OSI: ${fallbackOsi}`,
              );
            }
          } catch (err: any) {
            console.warn(
              `Order ${order.id}: could not resolve option osiKey: ${err?.message ?? err}`,
            );
            // Fallback on error too
            const fallbackOsi = this.buildOsiSymbol(
              order.symbol,
              exp,
              order.optionType!,
              order.strikePrice!,
            );
            etradeRequest = {
              ...etradeRequest,
              productId: { symbol: fallbackOsi, typeCode: "OPTION" },
            };
            console.log(
              `Order ${order.id}: using constructed OSI after chain error: ${fallbackOsi}`,
            );
          }
        }
      }

      if (process.env.ORDER_EXECUTOR_DEBUG === "true") {
        console.log("E*TRADE request:", JSON.stringify(etradeRequest, null, 2));
      } else {
        console.log(
          `E*TRADE placeOrder: ${order.symbol} ${order.action} qty=${order.quantity} term=${etradeRequest.orderTerm} session=${etradeRequest.marketSession}`,
        );
      }

      // Place order with E*TRADE
      const response = await this.etradeClient.placeOrder(etradeRequest);

      // Check if placement was accepted — E*TRADE returns OrderIds on success.
      // Acceptance ≠ fill: the order is now OPEN at the broker. We persist
      // SUBMITTED here and let verifyOrderStatus transition to FILLED /
      // PARTIALLY_FILLED / EXPIRED / CANCELLED / REJECTED based on the broker's
      // actual order state (OrderDetail[0].status + Instrument[0].filledQuantity).
      const orderIds = (response as any).OrderIds;
      if (orderIds && orderIds.length > 0 && orderIds[0].orderId) {
        const etradeOrderId = orderIds[0].orderId.toString();

        await this.orderService.updateOrderStatus(order.id, "SUBMITTED", {
          etradeOrderId,
          submittedAt: new Date(),
        });

        await this.orderService.logExecution(order.id, "SUBMITTED", {
          etradeOrderId,
        });

        logOrderAttempt(order.id, order.symbol, true);
        console.log(
          `✓ Order ${order.id} placed successfully. E*TRADE Order ID: ${etradeOrderId}`,
        );

        return true;
      } else {
        // Check for error messages in response
        const errorMsg =
          (response as any).Order?.[0]?.messages?.Message?.[0]?.description ||
          "Order placement failed - no OrderIds returned";
        throw new Error(errorMsg);
      }
    } catch (error: any) {
      const baseErrorMessage =
        this.getETradeErrorMessage(error) || error?.message || "Unknown error";
      const errorMessage = await this.withRelatedOpenOrders(
        order,
        baseErrorMessage,
      );

      const isTokenError = /oauth_problem|token_rejected|token_expired/i.test(
        errorMessage,
      );
      if (isTokenError && !(order as any).__renewed) {
        console.log(
          `Token error on order ${order.id}; attempting renewAccessToken + retry`,
        );
        const renewal = await this.etradeClient.renewAccessToken();
        if (renewal.success) {
          (order as any).__renewed = true;
          await this.orderService.releaseLock(order.id);
          return await this.executeOrder(order, lockerId);
        }
        console.log(
          `Renewal failed (status=${renewal.status}): ${renewal.error}`,
        );
        // renewAccessToken already emits auth_status on token_rejected, but
        // surface a definitive expired event here too — covers the case where
        // the renewal failed for some other reason yet the order still cannot
        // proceed without re-authentication.
        broadcastAuthStatus({
          authenticated: false,
          sandbox: process.env.ETRADE_SANDBOX === "true",
          source: "expired",
        });
      }

      logOrderAttempt(order.id, order.symbol, false, errorMessage);
      console.error(`✗ Failed to execute order ${order.id}:`, errorMessage);

      await this.orderService.logExecution(order.id, "REJECTED", {
        errorMessage,
      });

      // Slice 6.3: auth failures don't burn the 3-strikes retry budget.
      // We park the order at PAUSED with a sentinel lastError; OrderService
      // .requeueAfterAuthRestore() puts it back to SCHEDULED once auth is
      // restored. retry_count is left untouched.
      if (isAuthError(errorMessage)) {
        await this.orderService.updateOrderStatus(order.id, "PAUSED", {
          lastError: "queued for auth recovery",
        });
        console.log(
          `Order ${order.id} parked at PAUSED — auth recovery in progress`,
        );
        return false;
      }

      // Non-auth failure: increment retry count and apply the backoff
      // schedule from Slice 6.3 ([1s, 5s, 20s] +jitter).
      const retryCount = await this.orderService.incrementRetryCount(order.id);

      if (retryCount >= order.maxRetries) {
        await this.orderService.updateOrderStatus(order.id, "REJECTED", {
          lastError: `Max retries exceeded. Last error: ${errorMessage}`,
        });
        console.log(
          `Order ${order.id} exceeded max retries, marked as REJECTED`,
        );
      } else {
        if (!order.scheduleEnabled) {
          await this.orderService.updateOrderStatus(order.id, "PAUSED", {
            lastError: errorMessage,
          });
          console.log(
            `Order ${order.id} failed during immediate/manual send and was parked at PAUSED`,
          );
          return false;
        }

        // retry_count was just bumped; the order will look like the i-th
        // retry, so use index = retryCount - 1 for the delay it just waited.
        const delayMs = backoffWithJitter(Math.max(0, retryCount - 1));
        await this.orderService.updateOrderStatus(order.id, "SCHEDULED", {
          lastError: errorMessage,
        });
        console.log(
          `Order ${order.id} will retry (attempt ${retryCount}/${order.maxRetries}) — backoff=${delayMs}ms`,
        );
      }

      return false;
    } finally {
      // Always release the lock
      await this.orderService.releaseLock(order.id);
    }
  }

  async verifyOrderStatus(order: Order): Promise<void> {
    if (!order.etradeOrderId) {
      console.warn(
        `Order ${order.id} has no E*TRADE order ID, cannot verify status`,
      );
      return;
    }

    try {
      const response = await this.etradeClient.getOrderStatus(
        order.accountId,
        order.etradeOrderId,
      );

      // Real status + fills live on OrderDetail[0]; the top-level `status`
      // field on the response is unreliable. See response shape in
      // etrade-documentation/api-test-results/test-results-list-and-place-order-*.json.
      const detail = response.OrderDetail?.[0];
      const rawStatus = String(
        detail?.status ?? response.status ?? "",
      ).toUpperCase();
      const instrument = detail?.Instrument?.[0];
      const filledQuantity = Number(instrument?.filledQuantity ?? 0);
      const orderedQuantity = Number(
        instrument?.orderedQuantity ?? order.quantity,
      );
      const avgPrice = Number(instrument?.averageExecutionPrice ?? 0) || undefined;
      const commission = Number(instrument?.estimatedCommission ?? 0) || undefined;
      const executedAt =
        typeof detail?.executedTime === "number" && detail.executedTime > 0
          ? new Date(detail.executedTime)
          : new Date();

      if (rawStatus === "EXECUTED" || rawStatus === "FILLED") {
        await this.handleFilled(order, filledQuantity || orderedQuantity, avgPrice);
      } else if (rawStatus === "PARTIAL") {
        await this.handlePartialFill(
          order,
          filledQuantity,
          orderedQuantity,
          executedAt,
        );
      } else if (rawStatus === "CANCELLED" || rawStatus === "CANCELED") {
        await this.orderService.updateOrderStatus(order.id, "CANCELLED", {
          cancelledAt: new Date(),
        });
      } else if (rawStatus === "REJECTED") {
        await this.orderService.updateOrderStatus(order.id, "REJECTED");
      } else if (rawStatus === "EXPIRED") {
        await this.orderService.updateOrderStatus(order.id, "EXPIRED", {
          expiresAt: new Date(),
        });
      }
      // OPEN (or anything else) → leave the order in its current state.
    } catch (error: any) {
      console.error(
        `Failed to verify order ${order.id} status:`,
        error.message,
      );
    }
  }

  /**
   * Transition an order to FILLED. If onlyFillOnce, cancel any future
   * scheduled clones in the lineage so we don't re-place a now-completed order.
   */
  private async handleFilled(order: Order, filledQty: number, avgPrice?: number): Promise<void> {
    await this.orderService.updateOrderStatus(order.id, "FILLED", {
      filledAt: new Date(),
    });
    if (filledQty > 0) {
      await this.orderService.updateOrderFilledQuantity(order.id, filledQty);
    }
    await this.orderService.logExecution(order.id, "FILLED", {
      filledQuantity: filledQty || undefined,
      averagePrice: avgPrice,
    });
    console.log(`✓ Order ${order.id} FILLED at E*TRADE (qty ${filledQty})`);

    if (order.onlyFillOnce) {
      const cancelled = await this.orderService.cancelClonesInLineage(
        order.parentId,
        order.id,
      );
      if (cancelled.length > 0) {
        console.log(
          `[only_fill_once] Cancelled ${cancelled.length} future clone(s) in lineage ${order.parentId}: ${cancelled.join(", ")}`,
        );
      }
    }

    await this.fireOnFilledCallback(order.id);
  }

  /**
   * Transition an order to PARTIALLY_FILLED. If onlyFillOnce, shrink the next
   * scheduled clone in the lineage to (orderedQuantity - filledQuantity) so
   * tomorrow's reattempt only seeks the remainder.
   */
  private async handlePartialFill(
    order: Order,
    filledQty: number,
    orderedQty: number,
    _executedAt: Date,
  ): Promise<void> {
    await this.orderService.updateOrderStatus(order.id, "PARTIALLY_FILLED", {
      filledAt: new Date(),
    });
    if (filledQty > 0) {
      await this.orderService.updateOrderFilledQuantity(order.id, filledQty);
    }
    await this.orderService.logExecution(order.id, "PARTIALLY_FILLED", {
      filledQuantity: filledQty || undefined,
    });
    console.log(
      `◐ Order ${order.id} PARTIAL fill at E*TRADE (${filledQty}/${orderedQty})`,
    );

    if (order.onlyFillOnce && filledQty > 0 && filledQty < orderedQty) {
      const remaining = orderedQty - filledQty;
      const updated = await this.orderService.updateNextCloneQuantity(
        order.parentId,
        order.id,
        remaining,
      );
      if (updated) {
        console.log(
          `[only_fill_once] Shrunk next clone ${updated} to remaining qty ${remaining}`,
        );
      }
    }

    await this.fireOnFilledCallback(order.id);
  }

  private async fireOnFilledCallback(orderId: string): Promise<void> {
    if (!this.onOrderFilled) return;
    const updated = await this.orderService.getOrder(orderId);
    if (!updated) return;
    try {
      await this.onOrderFilled(updated);
    } catch (error: any) {
      console.error(
        `Error in onOrderFilled callback for order ${orderId}:`,
        error.message,
      );
    }
  }

  private async withRelatedOpenOrders(
    order: Order,
    errorMessage: string,
  ): Promise<string> {
    if (!this.shouldShowOpenOrdersForError(errorMessage)) {
      return errorMessage;
    }

    try {
      const openOrders = await this.etradeClient.listOrders(
        order.accountId,
        "OPEN",
      );
      const symbol = order.symbol.toUpperCase();
      const matching = openOrders.filter((openOrder) =>
        this.openOrderTouchesSymbol(openOrder, symbol),
      );

      if (matching.length === 0) {
        return `${errorMessage}\n\nOpen ${symbol} orders: none found.`;
      }

      const details = matching
        .slice(0, 8)
        .map((openOrder) => this.formatOpenOrder(openOrder))
        .filter(Boolean);
      const suffix =
        matching.length > details.length
          ? `\n... ${matching.length - details.length} more`
          : "";

      return `${errorMessage}\n\nOpen ${symbol} orders:\n${details.join("\n")}${suffix}`;
    } catch (err: any) {
      return `${errorMessage}\nOpen-order lookup failed: ${err?.message ?? err}`;
    }
  }

  private shouldShowOpenOrdersForError(errorMessage: string): boolean {
    return /available shares|already allocated|security in your account|E\*TRADE error 1037/i.test(
      errorMessage,
    );
  }

  private openOrderTouchesSymbol(openOrder: any, symbol: string): boolean {
    const details = this.asArray(openOrder?.OrderDetail);
    return details.some((detail) =>
      this.asArray(detail?.Instrument).some((instrument) => {
        const productSymbol = String(
          instrument?.Product?.symbol ?? instrument?.Product?.Symbol ?? "",
        ).toUpperCase();
        return productSymbol === symbol;
      }),
    );
  }

  private formatOpenOrder(openOrder: any): string {
    const detail = this.asArray(openOrder?.OrderDetail)[0] ?? {};
    const instrument = this.asArray(detail?.Instrument)[0] ?? {};
    const product = instrument?.Product ?? {};
    const orderedQty = Number(
      instrument?.orderedQuantity ?? instrument?.quantity ?? 0,
    );
    const filledQty = Number(instrument?.filledQuantity ?? 0);
    const remainingQty =
      orderedQty > 0 && filledQty > 0
        ? Math.max(0, orderedQty - filledQty)
        : orderedQty;
    const action = instrument?.orderAction ?? "UNKNOWN_ACTION";
    const symbol = product?.symbol ?? "?";
    const status = detail?.status ?? "?";
    const priceType = detail?.priceType ?? "?";
    const limit = Number(detail?.limitPrice ?? 0);
    const stop = Number(detail?.stopPrice ?? 0);
    const price =
      limit > 0 ? ` limit ${limit}` : stop > 0 ? ` stop ${stop}` : "";
    const session = detail?.marketSession ? ` ${detail.marketSession}` : "";
    return `#${openOrder?.orderId ?? "?"} ${status} ${action} ${remainingQty} ${symbol} ${priceType}${price}${session}`;
  }

  private asArray<T>(value: T | T[] | null | undefined): T[] {
    if (value == null) return [];
    return Array.isArray(value) ? value : [value];
  }

  private mapToETradeRequest(order: Order): ETradeOrderRequest {
    const isOption = order.securityType === "OPTION";

    // For threshold orders, use threshold quantity if available
    const quantity =
      order.thresholdEnabled && order.thresholdQuantity != null
        ? order.thresholdQuantity
        : order.quantity;

    const orderAction = this.mapOrderActionForETrade(order.action, isOption);

    const request: ETradeOrderRequest = {
      accountIdKey: order.accountId,
      symbol: order.symbol,
      orderAction,
      clientOrderId: `ord${Date.now()}`, // ≤20 alphanumeric (E*TRADE)
      priceType: this.mapOrderType(order.orderType),
      quantity,
      orderTerm: this.mapDuration(order.actualDuration),
      marketSession: order.sessionTime === "EXTENDED" ? "EXTENDED" : "REGULAR",
      allOrNone: false,
      securityType: isOption ? "OPTN" : "EQ",
    };

    // Option-specific mapping
    if (isOption) {
      if (order.optionType) {
        request.callPut = order.optionType;
      }

      const expDate = this.normalizeExpirationDate(order.expirationDate);
      if (expDate && !Number.isNaN(expDate.getTime())) {
        request.expiryYear = expDate.getFullYear();
        request.expiryMonth = expDate.getMonth() + 1;
        request.expiryDay = expDate.getDate();
      }

      if (typeof order.strikePrice === "number") {
        request.strikePrice = order.strikePrice;
      }

      if (order.optionSymbol) {
        request.productId = {
          symbol: order.optionSymbol,
          typeCode: "OPTION",
        };
      }
    }

    // Only include price fields if they have values
    if (order.limitPrice != null) {
      request.limitPrice = order.limitPrice;
    }
    if (order.stopPrice != null) {
      request.stopPrice = order.stopPrice;
    }

    return request;
  }

  /** Normalize expiration to Date (DB can return Date or serialized string). */
  private normalizeExpirationDate(
    val: Date | string | undefined | null,
  ): Date | null {
    if (val == null) return null;
    if (val instanceof Date) return val;
    const s = String(val);
    const d = /^\d{4}-\d{2}-\d{2}/.test(s)
      ? new Date(s.slice(0, 10) + "T12:00:00.000Z")
      : new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /**
   * Build OCC-format OSI symbol: SYMBOL + YYMMDD + C/P + strike×1000 (8 digits).
   * Example: SNDK260515C01450000
   */
  private buildOsiSymbol(
    symbol: string,
    expiration: Date,
    callPut: "CALL" | "PUT",
    strikePrice: number,
  ): string {
    const sym = symbol.toUpperCase().padEnd(6, " ").slice(0, 6).trimEnd();
    const yy = String(expiration.getUTCFullYear()).slice(2);
    const mm = String(expiration.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(expiration.getUTCDate()).padStart(2, "0");
    const cp = callPut === "CALL" ? "C" : "P";
    const strikePart = String(Math.round(strikePrice * 1000)).padStart(8, "0");
    return `${sym}${yy}${mm}${dd}${cp}${strikePart}`;
  }

  /** Extract readable message from E*TRADE/axios error (JSON or XML). */
  private getETradeErrorMessage(error: any): string | null {
    const data = error?.response?.data;
    if (data == null) return null;
    if (typeof data === "string") {
      const code = data.match(/<code[^>]*>([^<]+)<\/code>/i)?.[1]?.trim();
      const message = data
        .match(/<message[^>]*>([^<]+)<\/message>/i)?.[1]
        ?.trim()
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
      if (message) {
        return code ? `E*TRADE error ${code}: ${message}` : message;
      }
      return null;
    }
    if (typeof data !== "object") return null;
    const msg =
      data.Error?.message ??
      data.message ??
      data.error ??
      data.Error?.description;
    if (typeof msg === "string" && msg.length > 0) return msg;
    const arr =
      data.PreviewOrderResponse?.Order?.[0]?.messages?.Message ??
      data.Order?.[0]?.messages?.Message;
    const first = Array.isArray(arr) ? arr[0] : arr;
    const desc = first?.description ?? first?.message;
    if (typeof desc === "string" && desc.length > 0) return desc;
    return null;
  }

  /** For options E*TRADE requires Buy Open, Sell Open, Buy Close, Sell Close (we send BUY_OPEN etc.). */
  private mapOrderActionForETrade(
    action: Order["action"],
    isOption: boolean,
  ): ETradeOrderRequest["orderAction"] {
    if (!isOption) return action as ETradeOrderRequest["orderAction"];
    const map: Record<Order["action"], ETradeOrderRequest["orderAction"]> = {
      BUY: "BUY_OPEN",
      SELL: "SELL_CLOSE",
      BUY_TO_COVER: "BUY_CLOSE",
      SELL_SHORT: "SELL_OPEN",
    };
    return map[action] ?? (action as ETradeOrderRequest["orderAction"]);
  }

  private mapOrderType(
    orderType: string,
  ): "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT" {
    return orderType as "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
  }

  private mapDuration(
    duration: OrderDuration,
  ):
    | "GOOD_UNTIL_CANCEL"
    | "GOOD_FOR_DAY"
    | "IMMEDIATE_OR_CANCEL"
    | "FILL_OR_KILL" {
    const mapping: Record<
      OrderDuration,
      | "GOOD_UNTIL_CANCEL"
      | "GOOD_FOR_DAY"
      | "IMMEDIATE_OR_CANCEL"
      | "FILL_OR_KILL"
    > = {
      GTC: "GOOD_UNTIL_CANCEL",
      DAY: "GOOD_FOR_DAY",
      IMMEDIATE_OR_CANCEL: "IMMEDIATE_OR_CANCEL",
      FILL_OR_KILL: "FILL_OR_KILL",
    };
    return mapping[duration];
  }
}
