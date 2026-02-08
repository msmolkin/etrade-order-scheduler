/**
 * Caffeinated SEZL short script: shorts 100 shares of SEZL at $68.05 in 10 orders
 * of 10 shares each. After each order is placed, polls E*TRADE every 15 seconds
 * until the order is FILLED, then places the next order. Repeats 10 times.
 *
 * At 8:00 PM local time, the script exits and puts the computer to sleep.
 *
 * Run with macOS caffeinate to prevent sleep during the run:
 *   npm run sezl:short:caffeinated
 *
 * Failsafe: shell triggers sleep on exit only when it's 8 PM or later (so early exit/crash won't sleep):
 *   npm run sezl:short:caffeinated:sleep
 * Or (zsh/bash): caffeinate -s -i tsx src/scripts/sezl-short-caffeinated.ts; h=$(date +%H); h=$((h+0)); [ $h -ge 20 ] && pmset sleepnow
 */

import { spawn } from 'child_process';
import dotenv from 'dotenv';
import { ETradeClient } from '../server/services/etrade-client.js';
import type { ETradeCredentials, ETradeOrderRequest } from '../shared/types/index.js';

dotenv.config({ quiet: true });

const SYMBOL = 'SEZL';
const LIMIT_PRICE = 67.95;
const SHARES_PER_ORDER = 10;
const TOTAL_ORDERS = 10;
const POLL_INTERVAL_MS = 15_000;
const TIMEZONE = process.env.TZ ?? 'America/New_York';

function timeRoundedToTenSeconds(): string {
  const d = new Date();
  const roundedMs = Math.round(d.getTime() / 10_000) * 10_000;
  return new Date(roundedMs).toLocaleTimeString('en-US', {
    timeZone: TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

function get8PMDeadline(): Date {
  const now = new Date();
  const deadline = new Date(now);
  deadline.setHours(20, 0, 0, 0);
  if (now >= deadline) {
    deadline.setDate(deadline.getDate() + 1);
  }
  return deadline;
}

function isPast8PM(): boolean {
  const now = new Date();
  return now.getHours() >= 20;
}

function putComputerToSleep(): void {
  console.log('\nPutting computer to sleep in 2 seconds...');
  setTimeout(() => {
    const child = spawn('pmset', ['sleepnow'], { stdio: 'ignore', detached: true });
    child.unref();
  }, 2000);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const deadline = get8PMDeadline();
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     SEZL Short – 100 shares @ $68.05 (10 × 10)            ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
  console.log(`Shutdown at 8:00 PM. Deadline: ${deadline.toLocaleString()}\n`);

  if (isPast8PM()) {
    console.log('Already past 8:00 PM. Exiting and putting computer to sleep.');
    putComputerToSleep();
    process.exit(0);
  }

  const isSandbox = process.env.ETRADE_SANDBOX === 'true';
  const credentials: ETradeCredentials = isSandbox
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

  if (!credentials.consumerKey || !credentials.consumerSecret) {
    const keyNames = isSandbox
      ? 'ETRADE_SANDBOX_KEY or ETRADE_SANDBOX_SECRET'
      : 'ETRADE_CONSUMER_KEY or ETRADE_CONSUMER_SECRET';
    console.error(`ERROR: Missing ${keyNames}`);
    process.exit(1);
  }

  if (!credentials.accessToken || !credentials.accessTokenSecret) {
    const tokenNames = isSandbox
      ? 'ETRADE_SANDBOX_ACCESS_TOKEN or ETRADE_SANDBOX_ACCESS_TOKEN_SECRET'
      : 'ETRADE_ACCESS_TOKEN or ETRADE_ACCESS_TOKEN_SECRET';
    console.error(`ERROR: Missing ${tokenNames}. Please run the OAuth flow first.`);
    process.exit(1);
  }

  const client = new ETradeClient(credentials, isSandbox);

  let accountIdKey: string;
  try {
    const accounts = await client.getAccounts();
    if (!accounts?.length) {
      console.error('ERROR: No accounts found');
      process.exit(1);
    }
    const accountNickname = process.env.ACCOUNT;
    const activeAccounts = accounts.filter((acc: { accountStatus: string }) => acc.accountStatus === 'ACTIVE');
    if (!activeAccounts.length) {
      console.error('ERROR: No active accounts found');
      process.exit(1);
    }
    const matching = accountNickname
      ? activeAccounts.find((acc: { accountId: string }) =>
          String(acc.accountId).endsWith(String(accountNickname))
        )
      : null;
    const account = matching ?? activeAccounts[0];
    accountIdKey = account.accountIdKey;
    console.log(`Account: ${account.accountName || account.accountDesc} (${account.accountId})\n`);
  } catch (err: unknown) {
    console.error('ERROR: Failed to get accounts:', (err as Error).message);
    process.exit(1);
  }

  const skipPreview = process.env.SKIP_PREVIEW === 'true';
  let filledCount = 0;

  for (let round = 1; round <= TOTAL_ORDERS; round++) {
    if (isPast8PM()) {
      console.log('\n8:00 PM reached. Shutting down and putting computer to sleep.');
      putComputerToSleep();
      process.exit(0);
    }

    console.log(`\n--- Order ${round}/${TOTAL_ORDERS}: SELL_SHORT ${SHARES_PER_ORDER} SEZL @ $${LIMIT_PRICE} ---`);

    const orderRequest: ETradeOrderRequest = {
      accountIdKey,
      symbol: SYMBOL,
      securityType: 'EQ',
      orderAction: 'SELL_SHORT',
      clientOrderId: `sezl${round}-${Date.now()}`.slice(0, 20),
      priceType: 'LIMIT',
      quantity: SHARES_PER_ORDER,
      limitPrice: LIMIT_PRICE,
      orderTerm: 'GOOD_FOR_DAY',
      marketSession: 'REGULAR',
    };

    let orderId: string;
    try {
      const response = skipPreview
        ? await client.placeOrderDirect(orderRequest)
        : await client.placeOrder(orderRequest);
      const orderIds = (response as { OrderIds?: { orderId: number }[] })?.OrderIds;
      if (!orderIds?.length || orderIds[0].orderId == null) {
        console.error('Place order failed: no order ID in response');
        process.exit(1);
      }
      orderId = String(orderIds[0].orderId);
      console.log(`  Placed. E*TRADE order ID: ${orderId}`);
    } catch (err: unknown) {
      console.error('  Place order failed:', (err as Error).message);
      process.exit(1);
    }

    for (;;) {
      if (isPast8PM()) {
        console.log('\n8:00 PM reached. Shutting down and putting computer to sleep.');
        putComputerToSleep();
        process.exit(0);
      }

      await sleep(POLL_INTERVAL_MS);

      let statusResp: { status?: string; OrderDetail?: Array<{ status?: string }> };
      try {
        statusResp = await client.getOrderStatus(accountIdKey, orderId);
      } catch (err: unknown) {
        console.warn(`  Status check failed: ${(err as Error).message}`);
        continue;
      }

      const rawStatus =
        statusResp?.OrderDetail?.[0]?.status ?? statusResp?.status ?? '';
      const status = rawStatus.toUpperCase();
      console.log(`  Status: ${status} (${timeRoundedToTenSeconds()})`);

      if (status === 'FILLED' || status === 'EXECUTED') {
        filledCount += SHARES_PER_ORDER;
        console.log(`  Filled. Total filled: ${filledCount} shares.`);
        break;
      }
      if (['CANCELLED', 'REJECTED', 'EXPIRED'].includes(status)) {
        console.error(`  Order ${status.toLowerCase()}. Stopping.`);
        process.exit(1);
      }
    }
  }

  console.log(`\n✓ Done. All ${TOTAL_ORDERS} orders filled. Total: ${filledCount} shares short.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
