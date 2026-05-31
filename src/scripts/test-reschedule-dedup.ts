// Reproduces the duplicate-clones bug: rescheduleRecurringOrders called multiple
// times for the same overdue order must NOT create multiple clones.
import dotenv from "dotenv";
dotenv.config();
import { LocalScheduler } from "../scheduler/local-scheduler.js";
import { OrderService } from "../server/services/order-service.js";
import { query, pool } from "../server/database/client.js";

class TestScheduler extends LocalScheduler {
  public async testReschedule(orders: any[]) {
    return (this as any).rescheduleRecurringOrders(orders);
  }
}

const TEST_SYMBOL = "__DEDUP_TEST__";

async function cleanup(): Promise<void> {
  await query("DELETE FROM orders WHERE symbol = $1", [TEST_SYMBOL]);
}

async function main(): Promise<void> {
  await cleanup();
  const orderService = new OrderService();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  yesterday.setHours(7, 0, 0, 0);

  const original = await orderService.createOrder({
    accountId: "TEST_ACCT",
    symbol: TEST_SYMBOL,
    securityType: "EQUITY" as any,
    action: "BUY" as any,
    orderType: "MARKET" as any,
    quantity: 1,
    preferredDuration: "DAY" as any,
    actualDuration: "DAY" as any,
    requiresDaily: true,
    sessionTime: "EXTENDED" as any,
    scheduledFor: yesterday,
    scheduleEnabled: true,
    scheduleFrequency: "DAILY" as any,
    scheduleOnce: false,
    status: "SCHEDULED" as any,
    retryCount: 0,
    maxRetries: 3,
    thresholdEnabled: false,
    sellOrderEnabled: false,
  } as any);

  const sched = new TestScheduler();

  // Two concurrent reschedule cycles in series — like cron + catch-up + due-orders all firing.
  await sched.testReschedule([original]);
  await sched.testReschedule([original]);
  await sched.testReschedule([original]);

  const r = await query(
    "SELECT count(*)::int AS n FROM orders WHERE symbol = $1 AND status = 'SCHEDULED' AND scheduled_for > now()",
    [TEST_SYMBOL],
  );
  const n: number = (r.rows[0] as any).n;
  await cleanup();
  await pool.end();

  if (n === 1) {
    console.log(`PASS: 1 clone created (got ${n})`);
    process.exit(0);
  } else {
    console.error(`FAIL: expected 1 clone, got ${n}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(2);
});
