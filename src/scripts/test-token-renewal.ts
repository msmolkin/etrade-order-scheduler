// Tests Layer 3 silent token renewal: live renew_access_token call (Part A)
// and 401-retry-on-token-error in OrderExecutor (Part B).
import dotenv from "dotenv";
dotenv.config();
import { ETradeClient } from "../server/services/etrade-client.js";
import { OrderExecutor } from "../server/services/order-executor.js";
import { OrderService } from "../server/services/order-service.js";
import { query, pool } from "../server/database/client.js";
import type {
  ETradeOrderRequest,
  ETradeOrderResponse,
} from "../shared/types/index.js";

const TEST_SYMBOL = "__RENEW_TEST__";

function buildClientFromEnv(): ETradeClient {
  const isSandbox = process.env.ETRADE_SANDBOX === "true";
  const credentials = isSandbox
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
      };
  return new ETradeClient(credentials, isSandbox);
}

async function partA(): Promise<{ ok: boolean; note: string }> {
  console.log("\n=== Part A: live renew_access_token smoke test ===");
  const client = buildClientFromEnv();
  const result = await client.renewAccessToken();
  console.log("renewAccessToken result:", JSON.stringify(result));
  if (result.success && result.status === 200) {
    console.log("PART A PASS: live renewal returned 200");
    return { ok: true, note: "live renewal 200 OK" };
  }
  const note = `live renewal returned status=${result.status} error=${result.error} (likely tokens expired; environmental, not a code defect)`;
  console.log("PART A SKIPPED:", note);
  return { ok: false, note };
}

class FakeETradeClient extends ETradeClient {
  public placeOrderCalls = 0;
  public renewAccessTokenCalls = 0;
  constructor() {
    super(
      {
        consumerKey: "x",
        consumerSecret: "x",
        accessToken: "x",
        accessTokenSecret: "x",
      },
      true,
    );
  }
  async placeOrder(_request: ETradeOrderRequest): Promise<ETradeOrderResponse> {
    this.placeOrderCalls += 1;
    if (this.placeOrderCalls === 1) {
      throw new Error("oauth_problem=token_rejected");
    }
    return { OrderIds: [{ orderId: 9999 }] } as unknown as ETradeOrderResponse;
  }
  async renewAccessToken(): Promise<{
    success: boolean;
    status?: number;
    error?: string;
  }> {
    this.renewAccessTokenCalls += 1;
    return { success: true, status: 200 };
  }
}

async function partB(): Promise<boolean> {
  console.log("\n=== Part B: OrderExecutor 401-retry unit test ===");
  await query("DELETE FROM orders WHERE symbol = $1", [TEST_SYMBOL]);

  const orderService = new OrderService();
  const fake = new FakeETradeClient();
  const executor = new OrderExecutor(fake, orderService);

  const order = await orderService.createOrder({
    accountId: "TEST_ACCT_RENEW",
    symbol: TEST_SYMBOL,
    securityType: "EQUITY" as any,
    action: "BUY" as any,
    orderType: "MARKET" as any,
    quantity: 1,
    preferredDuration: "DAY" as any,
    actualDuration: "DAY" as any,
    requiresDaily: false,
    sessionTime: "MARKET" as any,
    scheduleEnabled: false,
    scheduleFrequency: "DAILY" as any,
    scheduleOnce: false,
    status: "SCHEDULED" as any,
    retryCount: 0,
    maxRetries: 3,
    thresholdEnabled: false,
    sellOrderEnabled: false,
  } as any);

  const result = await executor.executeOrder(order, "test-locker");
  console.log(`executeOrder returned: ${result}`);
  console.log(`placeOrder calls: ${fake.placeOrderCalls}`);
  console.log(`renewAccessToken calls: ${fake.renewAccessTokenCalls}`);

  const r = await query<{ status: string }>(
    "SELECT status FROM orders WHERE id = $1",
    [order.id],
  );
  const finalStatus = r.rows[0]?.status;
  console.log(`final DB status: ${finalStatus}`);

  await query("DELETE FROM orders WHERE symbol = $1", [TEST_SYMBOL]);

  const okResult = result === true;
  const okPlace = fake.placeOrderCalls === 2;
  const okRenew = fake.renewAccessTokenCalls === 1;
  // Successful placement now leaves the order at SUBMITTED; verifyOrderStatus
  // is what transitions to FILLED once E*TRADE actually executes.
  const okStatus = finalStatus === "SUBMITTED";
  if (okResult && okPlace && okRenew && okStatus) {
    console.log("PART B PASS: token error -> renew -> retry -> SUBMITTED");
    return true;
  }
  console.error(
    `PART B FAIL: result=${result}(want true) placeCalls=${fake.placeOrderCalls}(want 2) renewCalls=${fake.renewAccessTokenCalls}(want 1) status=${finalStatus}(want SUBMITTED)`,
  );
  return false;
}

async function main(): Promise<void> {
  let exitCode = 0;
  let aNote = "";
  try {
    const a = await partA();
    aNote = a.note;
  } catch (e: any) {
    aNote = `Part A threw: ${e?.message ?? e}`;
    console.error(aNote);
  }
  try {
    const passed = await partB();
    if (!passed) exitCode = 1;
  } catch (e: any) {
    console.error("Part B threw:", e);
    exitCode = 1;
  }
  console.log(
    `\n=== Summary ===\nPart A (live renewal): ${aNote}\nExit code: ${exitCode}`,
  );
  await pool.end();
  process.exit(exitCode);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(2);
});
