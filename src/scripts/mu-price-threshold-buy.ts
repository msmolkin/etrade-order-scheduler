import { ETradeClient } from '../server/services/etrade-client.js';
import type { ETradeCredentials } from '../shared/types/index.js';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

/** E*TRADE raw quote market data (nested under quote.All in API response) */
interface ETradeQuoteAll {
  lastTrade?: number;
  previousClose?: number;
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  lastSize?: number;
  [key: string]: unknown;
}

const SYMBOL = 'MU';
const TARGET_PRICE = 389.01; // Buy when MU < 389.01
const TARGET_BID = 393; // Buy when MU bid > 393
const QUANTITY_PRICE = 50; // Shares to buy on price trigger
const QUANTITY_BID = 36; // Shares to buy on bid trigger
const POLL_INTERVAL_MS = 1000; // Check every second

async function fetchMuQuote(
  client: ETradeClient
): Promise<{
  lastOrPrev: number | null;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  lastSize: number | null;
}> {
  const quotes = await client.getQuote([SYMBOL]);
  if (!quotes || quotes.length === 0) {
    return {
      lastOrPrev: null,
      bid: null,
      ask: null,
      bidSize: null,
      askSize: null,
      lastSize: null,
    };
  }
  const quote = quotes[0] as ETradeQuoteAll & { All?: ETradeQuoteAll };
  const quoteData: ETradeQuoteAll = quote.All ?? quote;
  const lastOrPrevRaw = quoteData.lastTrade ?? quoteData.previousClose;
  const bidRaw = quoteData.bid;
  const askRaw = quoteData.ask;
  const bidSizeRaw = quoteData.bidSize;
  const askSizeRaw = quoteData.askSize;
  const lastSizeRaw = quoteData.lastSize;
  const lastOrPrev =
    typeof lastOrPrevRaw === 'number' && Number.isFinite(lastOrPrevRaw) ? lastOrPrevRaw : null;
  const bid = typeof bidRaw === 'number' && Number.isFinite(bidRaw) ? bidRaw : null;
  const ask = typeof askRaw === 'number' && Number.isFinite(askRaw) ? askRaw : null;
  const bidSize =
    typeof bidSizeRaw === 'number' && Number.isFinite(bidSizeRaw) ? bidSizeRaw : null;
  const askSize =
    typeof askSizeRaw === 'number' && Number.isFinite(askSizeRaw) ? askSizeRaw : null;
  const lastSize =
    typeof lastSizeRaw === 'number' && Number.isFinite(lastSizeRaw) ? lastSizeRaw : null;
  return { lastOrPrev, bid, ask, bidSize, askSize, lastSize };
}

async function main() {
  console.log(
    `=== ${SYMBOL} Threshold Buyer ===\n` +
      `Conditions:\n` +
      `  • Buy ${QUANTITY_PRICE} shares when ${SYMBOL} < $${TARGET_PRICE.toFixed(2)}\n` +
      `  • Buy ${QUANTITY_BID} shares when ${SYMBOL} bid > $${TARGET_BID.toFixed(2)}\n`
  );

  const isSandbox = process.env.ETRADE_SANDBOX === 'true';
  console.log(`Mode: ${isSandbox ? 'SANDBOX (Testing)' : 'PRODUCTION (Live Trading)'}\n`);

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
    console.error(`ERROR: Missing ${tokenNames}`);
    console.error('Please run the OAuth flow first to get access tokens.');
    process.exit(1);
  }

  const client = new ETradeClient(credentials, isSandbox);

  // Select account (matches pattern used in other scripts)
  let accountIdKey: string;
  try {
    console.log('Step 1: Fetching account information...');
    const accounts = await client.getAccounts();

    if (!accounts || accounts.length === 0) {
      console.error('ERROR: No accounts found');
      process.exit(1);
    }

    const accountNickname = process.env.ACCOUNT;
    const activeAccounts = accounts.filter((acc: any) => acc.accountStatus === 'ACTIVE');
    if (!activeAccounts.length) {
      console.error('ERROR: No active accounts found');
      process.exit(1);
    }

    let matchingAccount: any;
    if (accountNickname) {
      matchingAccount = activeAccounts.find((acc: any) =>
        String(acc.accountId).endsWith(String(accountNickname))
      );
      if (matchingAccount) {
        console.log(
          `Found account matching ACCOUNT env var '${accountNickname}': ${matchingAccount.accountId}`
        );
      } else {
        console.log(`WARNING: No account found ending with '${accountNickname}'`);
        console.log(`Available account IDs: ${activeAccounts.map((a: any) => a.accountId).join(', ')}`);
        console.log('Using first active account as fallback');
      }
    }

    const activeAccount = matchingAccount ?? activeAccounts[0];
    accountIdKey = activeAccount.accountIdKey;
    console.log(
      `Using account: ${activeAccount.accountName || activeAccount.accountDesc} (${activeAccount.accountId})\n`
    );
  } catch (e: unknown) {
    console.error('ERROR: Failed to get accounts:', (e as Error).message);
    process.exit(1);
  }

  console.log(
    `Started MU monitor. Will poll every ${POLL_INTERVAL_MS / 1000}s for:\n` +
      `  • Last/previous price < $${TARGET_PRICE.toFixed(2)} (BUY ${QUANTITY_PRICE})\n` +
      `  • Bid price > $${TARGET_BID.toFixed(2)} (BUY ${QUANTITY_BID})\n`
  );

  const startTime = Date.now();

  while (true) {
    try {
      const { lastOrPrev, bid, ask, bidSize, askSize, lastSize } = await fetchMuQuote(client);
      const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);

      if (lastOrPrev == null && bid == null && ask == null) {
        process.stdout.write(`\r[${elapsedSeconds}s] MU quote unavailable, retrying...   `);
      } else {
        const bidDisplay = bid != null ? `$${bid.toFixed(2)}` : 'N/A';
        const askDisplay = ask != null ? `$${ask.toFixed(2)}` : 'N/A';
        const lastDisplay = lastOrPrev != null ? `$${lastOrPrev.toFixed(2)}` : 'N/A';
        const bidSizeDisplay = bidSize != null ? bidSize.toLocaleString() : 'N/A';
        const askSizeDisplay = askSize != null ? askSize.toLocaleString() : 'N/A';
        const lastSizeDisplay = lastSize != null ? lastSize.toLocaleString() : '';

        const tickerLast =
          lastSizeDisplay && lastSizeDisplay !== '0'
            ? `Last: ${lastDisplay} (${lastSizeDisplay})`
            : `Last: ${lastDisplay}`;

        process.stdout.write(
          `\r[${elapsedSeconds}s] Bid: ${bidDisplay} (${bidSizeDisplay}) | Ask: ${askDisplay} (${askSizeDisplay}) | ${tickerLast}   `
        );

        // Check bid trigger first (explicit request)
        if (bid != null && bid > TARGET_BID) {
          console.log(
            `\n[THRESHOLD] MU bid $${bid.toFixed(
              2
            )} is above $${TARGET_BID.toFixed(2)}. Placing BUY ${QUANTITY_BID} order...`
          );

          const clientOrderId = `mu${Date.now()}`.slice(0, 20);
          const request = {
            accountIdKey,
            symbol: SYMBOL,
            securityType: 'EQ' as const,
            orderAction: 'BUY' as const,
            priceType: 'MARKET' as const,
            quantity: QUANTITY_BID,
            orderTerm: 'GOOD_FOR_DAY' as const,
            marketSession: 'REGULAR' as const,
            clientOrderId,
          };

          try {
            const skipPreview = process.env.SKIP_PREVIEW === 'true';
            const response = skipPreview
              ? await client.placeOrderDirect(request)
              : await client.placeOrder(request);
            const orderIds = (response as { OrderIds?: { orderId: number }[] })?.OrderIds;
            console.log(
              `Order placed (bid trigger). E*TRADE Order ID: ${
                orderIds?.[0]?.orderId ?? 'see full response'
              }`
            );
            process.exit(0);
          } catch (err: unknown) {
            console.error('Order placement failed (bid trigger):', (err as Error).message);
            process.exit(1);
          }
        }

        // Then check price trigger
        if (lastOrPrev != null && lastOrPrev < TARGET_PRICE) {
          console.log(
            `\n[THRESHOLD] MU price $${lastOrPrev.toFixed(
              2
            )} is below $${TARGET_PRICE.toFixed(2)}. Placing BUY ${QUANTITY_PRICE} order...`
          );

          const clientOrderId = `mu${Date.now()}`.slice(0, 20);
          const request = {
            accountIdKey,
            symbol: SYMBOL,
            securityType: 'EQ' as const,
            orderAction: 'BUY' as const,
            priceType: 'MARKET' as const,
            quantity: QUANTITY_PRICE,
            orderTerm: 'GOOD_FOR_DAY' as const,
            marketSession: 'REGULAR' as const,
            clientOrderId,
          };

          try {
            const skipPreview = process.env.SKIP_PREVIEW === 'true';
            const response = skipPreview
              ? await client.placeOrderDirect(request)
              : await client.placeOrder(request);
            const orderIds = (response as { OrderIds?: { orderId: number }[] })?.OrderIds;
            console.log(
              `Order placed (price trigger). E*TRADE Order ID: ${
                orderIds?.[0]?.orderId ?? 'see full response'
              }`
            );
            process.exit(0);
          } catch (err: unknown) {
            console.error('Order placement failed (price trigger):', (err as Error).message);
            process.exit(1);
          }
        }
      }
    } catch (err: unknown) {
      console.error('\nPoll error:', (err as Error).message);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main();

