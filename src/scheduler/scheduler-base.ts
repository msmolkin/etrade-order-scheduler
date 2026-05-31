import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import { OrderService } from "../server/services/order-service.js";
import { OrderExecutor } from "../server/services/order-executor.js";
import { ETradeClient } from "../server/services/etrade-client.js";
import type {
  SessionTime,
  Order,
  ScheduleFrequency,
} from "../shared/types/index.js";
import { log as schedulerLog, error as schedulerError } from "./logger.js";

function getEtradeCredentialsFromEnv(): {
  credentials: {
    consumerKey: string;
    consumerSecret: string;
    accessToken?: string;
    accessTokenSecret?: string;
  };
  isSandbox: boolean;
} {
  const isSandbox = process.env.ETRADE_SANDBOX === "true";
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
    this.orderExecutor = new OrderExecutor(
      this.etradeClient,
      this.orderService,
    );
  }

  /** Re-read .env and recreate E*TRADE client/executor so new tokens are used without restart. */
  protected refreshCredentials(): void {
    dotenv.config({ override: true });
    const { credentials, isSandbox } = getEtradeCredentialsFromEnv();
    this.etradeClient = new ETradeClient(credentials, isSandbox);
    this.orderExecutor = new OrderExecutor(
      this.etradeClient,
      this.orderService,
    );
  }

  protected async processScheduledOrders(
    sessionTime: SessionTime,
  ): Promise<void> {
    const startTime = Date.now();
    this.refreshCredentials();
    schedulerLog(`[${this.schedulerId}] Processing ${sessionTime} orders...`);

    try {
      // Clean up any expired locks first
      await this.orderService.cleanupExpiredLocks();

      // Reconcile yesterday's SUBMITTED/PARTIALLY_FILLED orders before firing
      // today's clones. verifyOrderStatus may cancel future clones (cancel-on-fill
      // for onlyFillOnce orders) or shrink the next clone's quantity to the
      // remaining unfilled shares — both must happen before we query the
      // SCHEDULED batch below.
      await this.verifyRecentOrders();

      // Get orders scheduled for this time
      const orders = await this.orderService.getScheduledOrders(
        new Date(),
        sessionTime,
      );

      schedulerLog(
        `[${this.schedulerId}] Found ${orders.length} orders to execute`,
      );

      // Execute orders in parallel with concurrency limit
      const results = await this.executeBatch(orders, 5);

      const successful = results.filter((r) => r).length;
      const failed = results.length - successful;
      const elapsed = Date.now() - startTime;
      schedulerLog(
        `[${this.schedulerId}] Execution complete: ${successful} successful, ${failed} failed (${elapsed}ms)`,
      );

      // For recurring orders (daily/weekly) that are not one-time, reschedule them
      await this.rescheduleRecurringOrders(
        orders.filter((o) => o.scheduleEnabled && !o.scheduleOnce),
      );
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
      const allDue = await this.orderService.getOrdersDueByTime(new Date());
      if (allDue.length === 0) return;

      // Skip stale recurring orders (scheduled_for > 2h ago) — they missed
      // their window (e.g. auth was down). Reschedule instead of firing.
      const staleThreshold = Date.now() - 2 * 60 * 60_000;
      const orders: typeof allDue = [];
      const stale: typeof allDue = [];
      for (const o of allDue) {
        const sf = o.scheduledFor ? new Date(o.scheduledFor).getTime() : 0;
        if (
          o.scheduleEnabled &&
          !o.scheduleOnce &&
          sf > 0 &&
          sf < staleThreshold
        ) {
          stale.push(o);
        } else {
          orders.push(o);
        }
      }
      if (stale.length > 0) {
        schedulerLog(
          `[${this.schedulerId}] Skipping ${stale.length} stale recurring order(s): ${stale.map((o) => o.symbol).join(", ")}`,
        );
        await this.rescheduleRecurringOrders(stale);
      }
      if (orders.length === 0) return;

      schedulerLog(
        `[${this.schedulerId}] Due-orders check: ${orders.length} order(s) due`,
      );
      const results = await this.executeBatch(orders, 5);
      const successful = results.filter((r) => r).length;
      await this.rescheduleRecurringOrders(
        orders.filter((o) => o.scheduleEnabled && !o.scheduleOnce),
      );
      schedulerLog(
        `[${this.schedulerId}] Due-orders complete: ${successful}/${orders.length} successful`,
      );
    } catch (error: any) {
      schedulerError(
        `[${this.schedulerId}] processDueOrders: ${error?.message ?? error}`,
        error,
      );
    }
  }

  private async executeBatch(
    orders: Order[],
    concurrency: number,
  ): Promise<boolean[]> {
    const results: boolean[] = [];
    const executing: Promise<boolean>[] = [];

    for (const order of orders) {
      // Wrap executeOrder to ensure it always resolves (never rejects)
      const promise = this.orderExecutor
        .executeOrder(order, this.schedulerId)
        .catch((error: any) => {
          schedulerError(
            `executeBatch: order ${order.id} threw unhandled error: ${error?.message ?? error}`,
            error,
          );
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
      if (settled.status === "fulfilled") {
        results.push(settled.value);
      } else {
        schedulerError(
          `executeBatch: promise rejected: ${settled.reason?.message ?? settled.reason}`,
          settled.reason,
        );
        results.push(false);
      }
    }
    return results;
  }

  private async rescheduleRecurringOrders(orders: Order[]): Promise<void> {
    for (const order of orders) {
      try {
        if (
          order.onlyFillOnce &&
          (await this.orderService.lineageHasFilledOrder(order.parentId))
        ) {
          schedulerLog(
            `Skipping reschedule of ${order.id} — only_fill_once lineage ${order.parentId} already filled`,
          );
          continue;
        }

        const nextScheduledTime = this.getNextScheduledTime(
          order.sessionTime === "EXTENDED" ? "07:00" : "09:30",
          order.scheduleFrequency ?? "DAILY",
          order.scheduledFor,
        );

        const existing = await this.orderService.findExistingScheduledClone(
          order.parentId,
          nextScheduledTime,
        );
        if (existing) {
          schedulerLog(
            `Skipping reschedule of ${order.id} \u2014 clone ${existing.id} exists for ${order.symbol} at ${nextScheduledTime.toISOString()}`,
          );
          continue;
        }

        const {
          id: _id,
          parentId: _p,
          createdAt: _c,
          updatedAt: _u,
          ...rest
        } = order;
        await this.orderService.createOrder({
          ...rest,
          parentId: order.parentId,
          status: "SCHEDULED",
          scheduledFor: nextScheduledTime,
          etradeOrderId: undefined,
          submittedAt: undefined,
          filledAt: undefined,
          cancelledAt: undefined,
          expiresAt: undefined,
          lastError: undefined,
          retryCount: 0,
        });

        console.log(
          `Rescheduled order ${order.id} for ${nextScheduledTime.toISOString()}`,
        );
      } catch (error: any) {
        console.error(`Failed to reschedule order ${order.id}:`, error.message);
      }
    }
  }

  protected getNextScheduledTime(
    time: string,
    frequency: ScheduleFrequency,
    fromDate?: Date,
  ): Date {
    const [hours, minutes] = time.split(":").map(Number);
    const base = fromDate ? new Date(fromDate) : new Date();
    const next = new Date(base);
    next.setHours(hours, minutes, 0, 0);

    const incrementDays = frequency === "WEEKLY" ? 7 : 1;
    next.setDate(next.getDate() + incrementDays);

    // Advance past now() to avoid runaway rescheduling when fromDate is overdue
    while (next <= new Date()) {
      next.setDate(next.getDate() + incrementDays);
    }

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

  /**
   * Expire option orders whose underlying contract has expired.
   * An option is considered expired once 8 PM Eastern on its expiration_date has passed.
   */
  protected async expireOptionOrders(): Promise<void> {
    try {
      const orders = await this.orderService.getOptionOrdersPastExpiration();
      if (orders.length === 0) return;

      schedulerLog(
        `[${this.schedulerId}] Expiring ${orders.length} option order(s) past contract expiration`,
      );

      for (const order of orders) {
        try {
          await this.orderService.updateOrderStatus(order.id, "EXPIRED", {
            expiresAt: new Date(),
            lastError: `Option contract expired (expiration date: ${order.expirationDate instanceof Date ? order.expirationDate.toISOString().split("T")[0] : order.expirationDate})`,
          });
          schedulerLog(
            `[${this.schedulerId}] Expired order ${order.id} (${order.symbol} ${order.optionType} ${order.strikePrice} exp ${order.expirationDate})`,
          );
        } catch (err: any) {
          schedulerError(
            `[${this.schedulerId}] Failed to expire order ${order.id}: ${err?.message ?? err}`,
            err,
          );
        }
      }
    } catch (error: any) {
      schedulerError(
        `[${this.schedulerId}] expireOptionOrders: ${error?.message ?? error}`,
        error,
      );
    }
  }

  protected async verifyRecentOrders(): Promise<void> {
    this.refreshCredentials();
    try {
      // Verify any order whose final status isn't yet known: SUBMITTED orders
      // are awaiting fill/expiry; PARTIALLY_FILLED ones may still complete.
      const submitted = await this.orderService.getOrders({
        status: "SUBMITTED",
      });
      const partial = await this.orderService.getOrders({
        status: "PARTIALLY_FILLED",
      });
      const recentOrders = [...submitted, ...partial];

      console.log(`Verifying ${recentOrders.length} open orders...`);

      for (const order of recentOrders) {
        await this.orderExecutor.verifyOrderStatus(order);
      }
    } catch (error: any) {
      console.error("Error verifying recent orders:", error.message);
    }
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
}
