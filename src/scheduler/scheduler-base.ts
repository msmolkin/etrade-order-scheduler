import { v4 as uuidv4 } from 'uuid';
import { OrderService } from '../server/services/order-service.js';
import { OrderExecutor } from '../server/services/order-executor.js';
import { ETradeClient } from '../server/services/etrade-client.js';
import type { SessionTime, Order } from '../shared/types/index.js';

export abstract class SchedulerBase {
  protected schedulerId: string;
  protected orderService: OrderService;
  protected orderExecutor: OrderExecutor;
  protected etradeClient: ETradeClient;

  constructor() {
    this.schedulerId = uuidv4();
    this.orderService = new OrderService();

    // Initialize E*TRADE client
    this.etradeClient = new ETradeClient(
      {
        consumerKey: process.env.ETRADE_CONSUMER_KEY!,
        consumerSecret: process.env.ETRADE_CONSUMER_SECRET!,
        accessToken: process.env.ETRADE_ACCESS_TOKEN,
        accessTokenSecret: process.env.ETRADE_ACCESS_TOKEN_SECRET,
      },
      process.env.ETRADE_SANDBOX === 'true'
    );

    this.orderExecutor = new OrderExecutor(this.etradeClient, this.orderService);
  }

  protected async processScheduledOrders(sessionTime: SessionTime): Promise<void> {
    const startTime = Date.now();
    console.log(`[${this.schedulerId}] Processing ${sessionTime} orders...`);

    try {
      // Clean up any expired locks first
      await this.orderService.cleanupExpiredLocks();

      // Get orders scheduled for this time
      const orders = await this.orderService.getScheduledOrders(new Date(), sessionTime);

      console.log(`[${this.schedulerId}] Found ${orders.length} orders to execute`);

      // Execute orders in parallel with concurrency limit
      const results = await this.executeBatch(orders, 5);

      const successful = results.filter((r) => r).length;
      const failed = results.length - successful;

      console.log(
        `[${this.schedulerId}] Execution complete: ${successful} successful, ${failed} failed (${Date.now() - startTime}ms)`
      );

      // For orders that require daily placement, reschedule them
      await this.rescheduleRecurringOrders(orders.filter((o) => o.requiresDaily));
    } catch (error: any) {
      console.error(`[${this.schedulerId}] Error processing scheduled orders:`, error.message);
    }
  }

  private async executeBatch(orders: Order[], concurrency: number): Promise<boolean[]> {
    const results: boolean[] = [];
    const executing: Promise<boolean>[] = [];

    for (const order of orders) {
      const promise = this.orderExecutor.executeOrder(order, this.schedulerId);
      executing.push(promise);

      if (executing.length >= concurrency) {
        const result = await Promise.race(executing);
        results.push(result);
        const index = executing.findIndex((p) => p === promise);
        executing.splice(index, 1);
      }
    }

    // Wait for remaining executions
    results.push(...(await Promise.all(executing)));
    return results;
  }

  private async rescheduleRecurringOrders(orders: Order[]): Promise<void> {
    for (const order of orders) {
      try {
        // Calculate next execution time (next trading day)
        const nextScheduledTime = this.getNextTradingDay(
          order.sessionTime === 'EXTENDED' ? '07:00' : '09:30'
        );

        // Create a new order for tomorrow
        await this.orderService.createOrder({
          ...order,
          id: undefined as any,
          status: 'SCHEDULED',
          scheduledFor: nextScheduledTime,
          etradeOrderId: undefined,
          submittedAt: undefined,
          filledAt: undefined,
          cancelledAt: undefined,
          expiresAt: undefined,
          lastError: undefined,
          retryCount: 0,
        });

        console.log(`Rescheduled order ${order.id} for ${nextScheduledTime.toISOString()}`);
      } catch (error: any) {
        console.error(`Failed to reschedule order ${order.id}:`, error.message);
      }
    }
  }

  protected getNextTradingDay(time: string): Date {
    const [hours, minutes] = time.split(':').map(Number);
    const next = new Date();
    next.setHours(hours, minutes, 0, 0);

    // Move to next day
    next.setDate(next.getDate() + 1);

    // Skip weekends
    const day = next.getDay();
    if (day === 0) {
      // Sunday -> Monday
      next.setDate(next.getDate() + 1);
    } else if (day === 6) {
      // Saturday -> Monday
      next.setDate(next.getDate() + 2);
    }

    return next;
  }

  protected isMarketOpen(): boolean {
    const now = new Date();
    const day = now.getDay();

    // Not weekend
    if (day === 0 || day === 6) return false;

    const hours = now.getHours();
    const minutes = now.getMinutes();
    const currentTime = hours * 60 + minutes;

    // Market hours: 9:30 AM - 4:00 PM EST
    const marketOpen = 9 * 60 + 30;
    const marketClose = 16 * 60;

    return currentTime >= marketOpen && currentTime < marketClose;
  }

  protected async verifyRecentOrders(): Promise<void> {
    try {
      // Get orders submitted in the last 24 hours
      const recentOrders = await this.orderService.getOrders({
        status: 'SUBMITTED',
      });

      console.log(`Verifying ${recentOrders.length} recent orders...`);

      for (const order of recentOrders) {
        await this.orderExecutor.verifyOrderStatus(order);
      }
    } catch (error: any) {
      console.error('Error verifying recent orders:', error.message);
    }
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
}
