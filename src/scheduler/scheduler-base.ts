import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import { OrderService } from '../server/services/order-service.js';
import { OrderExecutor } from '../server/services/order-executor.js';
import { ETradeClient } from '../server/services/etrade-client.js';
import type { SessionTime, Order } from '../shared/types/index.js';
import { log as schedulerLog, error as schedulerError } from './logger.js';

function getEtradeCredentialsFromEnv(): { credentials: { consumerKey: string; consumerSecret: string; accessToken?: string; accessTokenSecret?: string }; isSandbox: boolean } {
  const isSandbox = process.env.ETRADE_SANDBOX === 'true';
  return {
    credentials: isSandbox
      ? {
          consumerKey: process.env.ETRADE_SANDBOX_KEY!,
          consumerSecret: process.env.ETRADE_SANDBOX_SECRET!,
          accessToken: process.env.ETRADE_SANDBOX_ACCESS_TOKEN,
          accessTokenSecret: process.env.ETRADE_SANDBOX_ACCESS_TOKEN_SECRET,
        }
      : {
          consumerKey: process.env.ETRADE_CONSUMER_KEY!,
          consumerSecret: process.env.ETRADE_CONSUMER_SECRET!,
          accessToken: process.env.ETRADE_ACCESS_TOKEN,
          accessTokenSecret: process.env.ETRADE_ACCESS_TOKEN_SECRET,
        },
    isSandbox,
  };
}

export abstract class SchedulerBase {
  protected schedulerId: string;
  protected orderService: OrderService;
  protected orderExecutor: OrderExecutor;
  protected etradeClient: ETradeClient;

  constructor() {
    this.schedulerId = uuidv4();
    this.orderService = new OrderService();
    const { credentials, isSandbox } = getEtradeCredentialsFromEnv();
    this.etradeClient = new ETradeClient(credentials, isSandbox);
    this.orderExecutor = new OrderExecutor(this.etradeClient, this.orderService);
  }

  /** Re-read .env and recreate E*TRADE client/executor so new tokens are used without restart. */
  protected refreshCredentials(): void {
    dotenv.config();
    const { credentials, isSandbox } = getEtradeCredentialsFromEnv();
    this.etradeClient = new ETradeClient(credentials, isSandbox);
    this.orderExecutor = new OrderExecutor(this.etradeClient, this.orderService);
  }

  protected async processScheduledOrders(sessionTime: SessionTime): Promise<void> {
    const startTime = Date.now();
    this.refreshCredentials();
    schedulerLog(`[${this.schedulerId}] Processing ${sessionTime} orders...`);

    try {
      // Clean up any expired locks first
      await this.orderService.cleanupExpiredLocks();

      // Get orders scheduled for this time
      const orders = await this.orderService.getScheduledOrders(new Date(), sessionTime);

      schedulerLog(`[${this.schedulerId}] Found ${orders.length} orders to execute`);

      // Execute orders in parallel with concurrency limit
      const results = await this.executeBatch(orders, 5);

      const successful = results.filter((r) => r).length;
      const failed = results.length - successful;
      const elapsed = Date.now() - startTime;
      schedulerLog(`[${this.schedulerId}] Execution complete: ${successful} successful, ${failed} failed (${elapsed}ms)`);

      // For orders that require daily placement, reschedule them
      await this.rescheduleRecurringOrders(orders.filter((o) => o.requiresDaily));
    } catch (error: any) {
      const errMsg = `[${this.schedulerId}] Error processing scheduled orders: ${error?.message ?? error}`;
      schedulerError(errMsg, error);
    }
  }

  /** Process orders whose scheduled_time has passed (arbitrary-time scheduling, e.g. "in 30 seconds"). */
  protected async processDueOrders(): Promise<void> {
    this.refreshCredentials();
    try {
      await this.orderService.cleanupExpiredLocks();
      const orders = await this.orderService.getOrdersDueByTime(new Date());
      if (orders.length === 0) return;
      schedulerLog(`[${this.schedulerId}] Due-orders check: ${orders.length} order(s) due`);
      const results = await this.executeBatch(orders, 5);
      const successful = results.filter((r) => r).length;
      await this.rescheduleRecurringOrders(orders.filter((o) => o.requiresDaily));
      schedulerLog(`[${this.schedulerId}] Due-orders complete: ${successful}/${orders.length} successful`);
    } catch (error: any) {
      schedulerError(`[${this.schedulerId}] processDueOrders: ${error?.message ?? error}`, error);
    }
  }

  private async executeBatch(orders: Order[], concurrency: number): Promise<boolean[]> {
    const results: boolean[] = [];
    const executing: Promise<boolean>[] = [];

    for (const order of orders) {
      // Wrap executeOrder to ensure it always resolves (never rejects)
      const promise = this.orderExecutor.executeOrder(order, this.schedulerId)
        .catch((error: any) => {
          schedulerError(`executeBatch: order ${order.id} threw unhandled error: ${error?.message ?? error}`, error);
          return false; // Treat unhandled errors as failure
        });
      executing.push(promise);

      if (executing.length >= concurrency) {
        const result = await Promise.race(executing);
        results.push(result);
        const index = executing.findIndex((p) => p === promise);
        executing.splice(index, 1);
      }
    }

    // Wait for remaining executions, ensuring all promises resolve
    const remainingResults = await Promise.allSettled(executing);
    for (const settled of remainingResults) {
      if (settled.status === 'fulfilled') {
        results.push(settled.value);
      } else {
        schedulerError(`executeBatch: promise rejected: ${settled.reason?.message ?? settled.reason}`, settled.reason);
        results.push(false);
      }
    }
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
    this.refreshCredentials();
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
