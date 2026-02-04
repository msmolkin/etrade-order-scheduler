import { ETradeClient } from './etrade-client.js';
import { OrderService } from './order-service.js';
import type { Order, OrderDuration, ETradeOrderRequest } from '../../shared/types/index.js';
import { logOrderAttempt } from '../../scheduler/logger.js';

export class OrderExecutor {
  constructor(
    private etradeClient: ETradeClient,
    private orderService: OrderService
  ) {}

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
      await this.orderService.updateOrderStatus(order.id, 'SUBMITTED', {
        submittedAt: new Date(),
      });

      // Prepare E*TRADE order request
      const etradeRequest = this.mapToETradeRequest(order);
      if (process.env.ORDER_EXECUTOR_DEBUG === 'true') {
        console.log('E*TRADE request:', JSON.stringify(etradeRequest, null, 2));
      } else {
        console.log(
          `E*TRADE placeOrder: ${order.symbol} ${order.action} qty=${order.quantity} term=${etradeRequest.orderTerm} session=${etradeRequest.marketSession}`
        );
      }

      // Place order with E*TRADE
      const response = await this.etradeClient.placeOrder(etradeRequest);

      // Check if order was successful - E*TRADE returns OrderIds array on success
      const orderIds = (response as any).OrderIds;
      if (orderIds && orderIds.length > 0 && orderIds[0].orderId) {
        const etradeOrderId = orderIds[0].orderId.toString();

        await this.orderService.updateOrderStatus(order.id, 'FILLED', {
          etradeOrderId,
          filledAt: new Date(),
        });

        await this.orderService.logExecution(order.id, 'FILLED', {
          etradeOrderId,
        });

        logOrderAttempt(order.id, order.symbol, true);
        console.log(`✓ Order ${order.id} placed successfully. E*TRADE Order ID: ${etradeOrderId}`);
        return true;
      } else {
        // Check for error messages in response
        const errorMsg = (response as any).Order?.[0]?.messages?.Message?.[0]?.description
          || 'Order placement failed - no OrderIds returned';
        throw new Error(errorMsg);
      }
    } catch (error: any) {
      const errorMessage = error?.message || 'Unknown error';
      logOrderAttempt(order.id, order.symbol, false, errorMessage);
      console.error(`✗ Failed to execute order ${order.id}:`, errorMessage);

      await this.orderService.logExecution(order.id, 'REJECTED', {
        errorMessage,
      });

      // Increment retry count
      const retryCount = await this.orderService.incrementRetryCount(order.id);

      if (retryCount >= order.maxRetries) {
        await this.orderService.updateOrderStatus(order.id, 'REJECTED', {
          lastError: `Max retries exceeded. Last error: ${errorMessage}`,
        });
        console.log(`Order ${order.id} exceeded max retries, marked as REJECTED`);
      } else {
        await this.orderService.updateOrderStatus(order.id, 'SCHEDULED', {
          lastError: errorMessage,
        });
        console.log(`Order ${order.id} will retry (attempt ${retryCount}/${order.maxRetries})`);
      }

      return false;
    } finally {
      // Always release the lock
      await this.orderService.releaseLock(order.id);
    }
  }

  async verifyOrderStatus(order: Order): Promise<void> {
    if (!order.etradeOrderId) {
      console.warn(`Order ${order.id} has no E*TRADE order ID, cannot verify status`);
      return;
    }

    try {
      const status = await this.etradeClient.getOrderStatus(
        order.accountId,
        order.etradeOrderId
      );

      // Update our database based on E*TRADE status
      if (status.status === 'FILLED') {
        await this.orderService.updateOrderStatus(order.id, 'FILLED', {
          filledAt: new Date(),
        });
      } else if (status.status === 'CANCELLED') {
        await this.orderService.updateOrderStatus(order.id, 'CANCELLED', {
          cancelledAt: new Date(),
        });
      } else if (status.status === 'REJECTED') {
        await this.orderService.updateOrderStatus(order.id, 'REJECTED');
      } else if (status.status === 'EXPIRED') {
        await this.orderService.updateOrderStatus(order.id, 'EXPIRED', {
          expiresAt: new Date(),
        });
      }
    } catch (error: any) {
      console.error(`Failed to verify order ${order.id} status:`, error.message);
    }
  }

  private mapToETradeRequest(order: Order): ETradeOrderRequest {
    const isOption = order.securityType === 'OPTION';

    const request: ETradeOrderRequest = {
      accountIdKey: order.accountId,
      symbol: order.symbol,
      orderAction: order.action as ETradeOrderRequest['orderAction'],
      clientOrderId: `ord${Date.now()}`, // ≤20 alphanumeric (E*TRADE)
      priceType: this.mapOrderType(order.orderType),
      quantity: order.quantity,
      orderTerm: this.mapDuration(order.actualDuration),
      marketSession: order.sessionTime === 'EXTENDED' ? 'EXTENDED' : 'REGULAR',
      allOrNone: false,
      securityType: isOption ? 'OPTN' : 'EQ',
    };

    // Option-specific mapping
    if (isOption) {
      if (order.optionType) {
        request.callPut = order.optionType;
      }

      if (order.expirationDate instanceof Date && !isNaN(order.expirationDate.getTime())) {
        request.expiryYear = order.expirationDate.getFullYear();
        request.expiryMonth = order.expirationDate.getMonth() + 1;
        request.expiryDay = order.expirationDate.getDate();
      }

      if (typeof order.strikePrice === 'number') {
        request.strikePrice = order.strikePrice;
      }

      if (order.optionSymbol) {
        request.productId = {
          symbol: order.optionSymbol,
          typeCode: 'OPTION',
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

  private mapOrderType(orderType: string): 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT' {
    return orderType as 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
  }

  private mapDuration(duration: OrderDuration): 'GOOD_UNTIL_CANCEL' | 'GOOD_FOR_DAY' | 'IMMEDIATE_OR_CANCEL' | 'FILL_OR_KILL' {
    const mapping: Record<OrderDuration, 'GOOD_UNTIL_CANCEL' | 'GOOD_FOR_DAY' | 'IMMEDIATE_OR_CANCEL' | 'FILL_OR_KILL'> = {
      'GTC': 'GOOD_UNTIL_CANCEL',
      'DAY': 'GOOD_FOR_DAY',
      'IMMEDIATE_OR_CANCEL': 'IMMEDIATE_OR_CANCEL',
      'FILL_OR_KILL': 'FILL_OR_KILL',
    };
    return mapping[duration];
  }
}
