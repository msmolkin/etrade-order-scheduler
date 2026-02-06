/**
 * Silver price monitor and threshold order script.
 *
 * Polls silver price every 5 seconds (from MetalpriceAPI spot or E*TRADE SLV quote).
 * When price >= SILVER_HIGH or <= SILVER_LOW, places an E*TRADE market order for SLV
 * (or logs only if DRY_RUN=true).
 *
 * Price sources:
 * - metalpriceapi: Spot silver in USD per troy oz (rates.USDXAG). Set METALPRICEAPI_KEY.
 * - etrade: SLV (iShares Silver Trust) share price via E*TRADE quote. No extra API key.
 *
 * Threshold units: With SILVER_SOURCE=metalpriceapi use USD per troy oz (e.g. 28, 32).
 *                  With SILVER_SOURCE=etrade use dollars per SLV share.
 *
 * One order per threshold per run (no duplicate orders for same boundary).
 */

import { ETradeClient } from '../server/services/etrade-client.js';
import type { ETradeCredentials } from '../shared/types/index.js';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const POLL_INTERVAL_MS = 5000;

/** E*TRADE raw quote market data (nested under quote.All in API response) */
interface ETradeQuoteAll {
  lastTrade?: number;
  previousClose?: number;
  [key: string]: unknown;
}

type PriceSource = 'etrade' | 'metalpriceapi';

function getConfig() {
  const source = (process.env.SILVER_SOURCE ?? 'etrade').toLowerCase() as PriceSource;
  if (source !== 'etrade' && source !== 'metalpriceapi') {
    console.error(`ERROR: SILVER_SOURCE must be 'etrade' or 'metalpriceapi', got: ${process.env.SILVER_SOURCE}`);
    process.exit(1);
  }

  const highRaw = process.env.SILVER_HIGH;
  const lowRaw = process.env.SILVER_LOW;
  const high = highRaw != null && highRaw !== '' ? Number(highRaw) : NaN;
  const low = lowRaw != null && lowRaw !== '' ? Number(lowRaw) : NaN;

  if (!Number.isFinite(high) || !Number.isFinite(low)) {
    console.error('ERROR: SILVER_HIGH and SILVER_LOW must be numbers. Example: SILVER_HIGH=32 SILVER_LOW=28');
    process.exit(1);
  }

  if (low >= high) {
    console.error('ERROR: SILVER_LOW must be less than SILVER_HIGH');
    process.exit(1);
  }

  const quantity = Math.max(1, Math.floor(Number(process.env.SILVER_QUANTITY) || 1));
  const actionHigh = (process.env.SILVER_ACTION_HIGH ?? 'SELL').toUpperCase();
  const actionLow = (process.env.SILVER_ACTION_LOW ?? 'BUY').toUpperCase();
  const orderActionHigh = actionHigh === 'SELL' ? 'SELL' : 'BUY';
  const orderActionLow = actionLow === 'BUY' ? 'BUY' : 'SELL';
  const dryRun = process.env.DRY_RUN === 'true';

  return {
    source,
    high,
    low,
    quantity,
    orderActionHigh: orderActionHigh as 'BUY' | 'SELL',
    orderActionLow: orderActionLow as 'BUY' | 'SELL',
    dryRun,
  };
}

async function fetchSpotSilverPrice(apiKey: string): Promise<number | null> {
  const url = `https://api.metalpriceapi.com/v1/latest?api_key=${encodeURIComponent(apiKey)}&base=USD&currencies=XAG`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`MetalpriceAPI error: HTTP ${res.status}`);
    return null;
  }
  const data = (await res.json()) as { success?: boolean; rates?: { USDXAG?: number }; error?: { message?: string } };
  if (!data.success || data.rates?.USDXAG == null) {
    console.error('MetalpriceAPI error:', data.error?.message ?? 'missing rates.USDXAG');
    return null;
  }
  return data.rates.USDXAG;
}

async function fetchSlvPrice(client: ETradeClient): Promise<number | null> {
  const quotes = await client.getQuote(['SLV']);
  if (!quotes || quotes.length === 0) return null;
  const quote = quotes[0] as ETradeQuoteAll & { All?: ETradeQuoteAll };
  const quoteData: ETradeQuoteAll = quote.All ?? quote;
  const price = quoteData.lastTrade ?? quoteData.previousClose;
  return typeof price === 'number' && Number.isFinite(price) ? price : null;
}

async function main() {
  const config = getConfig();

  if (config.source === 'metalpriceapi') {
    if (!process.env.METALPRICEAPI_KEY?.trim()) {
      console.error('ERROR: SILVER_SOURCE=metalpriceapi requires METALPRICEAPI_KEY in .env');
      process.exit(1);
    }
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
    console.error('ERROR: Missing E*TRADE consumer key/secret');
    process.exit(1);
  }

  if (!credentials.accessToken || !credentials.accessTokenSecret) {
    console.error('ERROR: Missing E*TRADE access tokens. Please run OAuth flow first.');
    process.exit(1);
  }

  const client = new ETradeClient(credentials, isSandbox);

  let accountIdKey: string;
  try {
    const accounts = await client.getAccounts();
    if (!accounts || accounts.length === 0) {
      console.error('ERROR: No E*TRADE accounts found');
      process.exit(1);
    }
    const activeAccounts = accounts.filter((acc: { accountStatus?: string }) => acc.accountStatus === 'ACTIVE');
    if (!activeAccounts.length) {
      console.error('ERROR: No active accounts found');
      process.exit(1);
    }
    const accountNickname = process.env.ACCOUNT;
    const matching = accountNickname
      ? activeAccounts.find((acc: { accountId?: string }) => String(acc.accountId).endsWith(String(accountNickname)))
      : null;
    const activeAccount = matching ?? activeAccounts[0];
    accountIdKey = activeAccount.accountIdKey;
    console.log(`Using account: ${activeAccount.accountName || activeAccount.accountDesc} (${activeAccount.accountId})`);
  } catch (e: unknown) {
    console.error('ERROR: Failed to get accounts:', (e as Error).message);
    process.exit(1);
  }

  const unitLabel = config.source === 'metalpriceapi' ? 'USD/troy oz' : 'SLV $/share';
  console.log(`Silver monitor started. Source=${config.source}, high>=${config.high} ${unitLabel}, low<=${config.low} ${unitLabel}, poll=${POLL_INTERVAL_MS / 1000}s, dryRun=${config.dryRun}\n`);

  let highTriggered = false;
  let lowTriggered = false;

  while (true) {
    try {
      let price: number | null = null;
      if (config.source === 'metalpriceapi') {
        price = await fetchSpotSilverPrice(process.env.METALPRICEAPI_KEY!);
      } else {
        price = await fetchSlvPrice(client);
      }

      if (price != null && Number.isFinite(price)) {
        const now = new Date().toISOString();
        process.stdout.write(`\r[${now}] Price: ${price.toFixed(2)} ${unitLabel}   `);

        if (!highTriggered && price >= config.high) {
          highTriggered = true;
          console.log(`\n[THRESHOLD] Price ${price.toFixed(2)} >= ${config.high} (high) -> ${config.orderActionHigh} SLV x${config.quantity}`);
          if (!config.dryRun) {
            try {
              const clientOrderId = `slv${Date.now()}`.slice(0, 20);
              const request = {
                accountIdKey,
                symbol: 'SLV',
                securityType: 'EQ' as const,
                orderAction: config.orderActionHigh,
                priceType: 'MARKET' as const,
                quantity: config.quantity,
                orderTerm: 'GOOD_FOR_DAY' as const,
                marketSession: 'REGULAR' as const,
                clientOrderId,
              };
              const skipPreview = process.env.SKIP_PREVIEW === 'true';
              const response = skipPreview
                ? await client.placeOrderDirect(request)
                : await client.placeOrder(request);
              const orderIds = (response as { OrderIds?: { orderId: number }[] })?.OrderIds;
              console.log(`Order placed. Order ID: ${orderIds?.[0]?.orderId ?? 'see response'}`);
            } catch (err: unknown) {
              console.error('Order placement failed:', (err as Error).message);
            }
          }
        }

        if (!lowTriggered && price <= config.low) {
          lowTriggered = true;
          console.log(`\n[THRESHOLD] Price ${price.toFixed(2)} <= ${config.low} (low) -> ${config.orderActionLow} SLV x${config.quantity}`);
          if (!config.dryRun) {
            try {
              const clientOrderId = `slv${Date.now()}`.slice(0, 20);
              const request = {
                accountIdKey,
                symbol: 'SLV',
                securityType: 'EQ' as const,
                orderAction: config.orderActionLow,
                priceType: 'MARKET' as const,
                quantity: config.quantity,
                orderTerm: 'GOOD_FOR_DAY' as const,
                marketSession: 'REGULAR' as const,
                clientOrderId,
              };
              const skipPreview = process.env.SKIP_PREVIEW === 'true';
              const response = skipPreview
                ? await client.placeOrderDirect(request)
                : await client.placeOrder(request);
              const orderIds = (response as { OrderIds?: { orderId: number }[] })?.OrderIds;
              console.log(`Order placed. Order ID: ${orderIds?.[0]?.orderId ?? 'see response'}`);
            } catch (err: unknown) {
              console.error('Order placement failed:', (err as Error).message);
            }
          }
        }
      }
    } catch (err: unknown) {
      console.error('Poll error:', (err as Error).message);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main();
