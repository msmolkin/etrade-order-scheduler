// Proves the parent_id dedup refactor: two independent recurring streams with
// identical params (e.g. two daily AMD MARKET buys for two strategies) must each
// receive their own clone every day. The OLD param-keyed dedup collapsed them to one.
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

const TEST_SYMBOL = "__DEDUP_TEST_INTENTIONAL_DUPS__";

async function cleanup(): Promise<void> {
  await query("DELETE FROM orders WHERE symbol = $1", [TEST_SYMBOL]);
}

async function main(): Promise<void> {
  await cleanup();
  const orderService = new OrderService();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  yesterday.setHours(7, 0, 0, 0);

  const baseInput = {
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
  };

  // Two ROOT recurring orders with identical params, distinct ids/parentIds.
  const orig1 = await orderService.createOrder({ ...baseInput } as any);
  const orig2 = await orderService.createOrder({ ...baseInput } as any);

  if (orig1.id === orig2.id) {
    console.error("FAIL: roots collided on id");
    process.exit(1);
  }
  if (orig1.parentId !== orig1.id || orig2.parentId !== orig2.id) {
    console.error(
      `FAIL: roots did not self-reference parent_id (orig1.id=${orig1.id} parentId=${orig1.parentId}; orig2.id=${orig2.id} parentId=${orig2.parentId})`,
    );
    process.exit(1);
  }

  const sched = new TestScheduler();
  await sched.testReschedule([orig1, orig2]);

  // Expect TWO future clones — one per stream.
  const r = await query(
    "SELECT count(*)::int AS n FROM orders WHERE symbol = $1 AND status = 'SCHEDULED' AND scheduled_for > now()",
    [TEST_SYMBOL],
  );
  const n: number = (r.rows[0] as any).n;

  // Also verify lineage: each clone should chain to the correct parent stream.
  const lineage = await query(
    "SELECT parent_id, count(*)::int AS n FROM orders WHERE symbol = $1 AND status = 'SCHEDULED' AND scheduled_for > now() GROUP BY parent_id ORDER BY parent_id",
    [TEST_SYMBOL],
  );
  const parents = new Set(lineage.rows.map((row: any) => row.parent_id));
  const eachStreamGotOne = lineage.rows.every((row: any) => row.n === 1);

  await cleanup();
  await pool.end();

  if (
    n === 2 &&
    parents.size === 2 &&
    parents.has(orig1.parentId) &&
    parents.has(orig2.parentId) &&
    eachStreamGotOne
  ) {
    console.log(
      `PASS: 2 independent streams each got 1 clone (total=${n}, distinct parents=${parents.size})`,
    );
    process.exit(0);
  } else {
    console.error(
      `FAIL: expected 2 clones across 2 distinct parents, got total=${n}, distinct parents=${parents.size}, perStream=${JSON.stringify(lineage.rows)}`,
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(2);
});
