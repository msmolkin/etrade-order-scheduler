import { ETradeClient } from './etrade-client.js';
import { OrderService } from './order-service.js';
import type { Order, OrderDuration, ETradeOrderRequest } from '../../shared/types/index.js';

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
      console.log('E*TRADE request:', JSON.stringify(etradeRequest, null, 2));

      // Place order with E*TRADE
      const response = await this.etradeClient.placeOrder(etradeRequest);

      // Check if order was successful
      if (response.status === 'OPEN' || response.status === 'FILLED') {
        await this.orderService.updateOrderStatus(order.id, 'FILLED', {
          etradeOrderId: response.orderId.toString(),
          filledAt: new Date(),
        });

        await this.orderService.logExecution(order.id, 'FILLED', {
          etradeOrderId: response.orderId.toString(),
        });

        console.log(`✓ Order ${order.id} placed successfully. E*TRADE Order ID: ${response.orderId}`);
        return true;
      } else {
        throw new Error(`Order rejected with status: ${response.status}`);
      }
    } catch (error: any) {
      const errorMessage = error?.message || 'Unknown error';
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
    const request: ETradeOrderRequest = {
      accountIdKey: order.accountId,
      symbol: order.symbol,
      orderAction: order.action,
      clientOrderId: `order-${Date.now()}`,
      priceType: this.mapOrderType(order.orderType),
      quantity: order.quantity,
      orderTerm: this.mapDuration(order.actualDuration),
      marketSession: order.sessionTime === 'EXTENDED' ? 'EXTENDED' : 'REGULAR',
      allOrNone: false,
    };
    // Only include price fields if they have values
    if (order.limitPrice) request.limitPrice = order.limitPrice;
    if (order.stopPrice) request.stopPrice = order.stopPrice;
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
