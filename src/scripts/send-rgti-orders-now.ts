import dotenv from 'dotenv';
import { OrderService } from '../server/services/order-service.js';
import { OrderExecutor } from '../server/services/order-executor.js';
import { ETradeClient } from '../server/services/etrade-client.js';

dotenv.config();

async function sendRGTIOrdersNow() {
  console.log('Fetching RGTI current quote...\n');

  // Initialize E*TRADE client
  const etradeClient = new ETradeClient(
    {
      consumerKey: process.env.ETRADE_CONSUMER_KEY!,
      consumerSecret: process.env.ETRADE_CONSUMER_SECRET!,
      accessToken: process.env.ETRADE_ACCESS_TOKEN,
      accessTokenSecret: process.env.ETRADE_ACCESS_TOKEN_SECRET,
    },
    process.env.ETRADE_SANDBOX === 'true'
  );

  // Get account ID
  const accounts = await etradeClient.getAccounts();
  if (accounts.length === 0) {
    console.error('No accounts found');
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
      console.log(`Found account matching ACCOUNT env var '${accountNickname}': ${matchingAccount.accountId}`);
    } else {
      console.log(`WARNING: No account found ending with '${accountNickname}'`);
      console.log(`Available account IDs: ${activeAccounts.map((a: any) => a.accountId).join(', ')}`);
      console.log(`Using first active account as fallback`);
    }
  }
  const activeAccount = matchingAccount ?? activeAccounts[0];
  const accountIdKey = activeAccount.accountIdKey;
  console.log(`\nUsing account: ${activeAccount.accountName || activeAccount.accountDesc}`);
  console.log(`Account ID: ${activeAccount.accountId}`);
  console.log(`Account Key: ${accountIdKey}`);
  console.log(`Trading mode: ${process.env.ETRADE_SANDBOX === 'true' ? 'SANDBOX' : 'PRODUCTION'}\n`);

  // Initialize services
  const orderService = new OrderService();
  const orderExecutor = new OrderExecutor(etradeClient, orderService);

  // Get current quote for RGTI to get bid/ask prices - try multiple times if needed
  let currentBid = 0;
  let currentAsk = 0;
  let lastPrice = 0;
  let quoteAttempts = 0;
  const maxQuoteAttempts = 3;
  
  while (quoteAttempts < maxQuoteAttempts && (currentBid === 0 || currentAsk === 0)) {
    try {
      const quotes = await etradeClient.getQuote(['RGTI']);
      if (quotes && quotes.length > 0) {
        // E*TRADE API nests market data inside an 'All' object
        const quoteData = quotes[0].All || quotes[0];
        currentBid = quoteData.bid || 0;
        currentAsk = quoteData.ask || 0;
        lastPrice = quoteData.lastTrade || quoteData.previousClose || 0;
        console.log(`Current RGTI Quote (attempt ${quoteAttempts + 1}):`);
        console.log(`  Bid: $${currentBid || 'N/A'}`);
        console.log(`  Ask: $${currentAsk || 'N/A'}`);
        console.log(`  Last: $${lastPrice || 'N/A'}\n`);
        
        // If we got valid bid/ask, break
        if (currentBid > 0 && currentAsk > 0) break;
      }
    } catch (error: any) {
      console.warn(`Warning: Could not fetch quote (attempt ${quoteAttempts + 1}): ${error.message}`);
    }
    
    quoteAttempts++;
    if (quoteAttempts < maxQuoteAttempts && (currentBid === 0 || currentAsk === 0)) {
      console.log('Retrying quote fetch in 1 second...\n');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // If we still don't have bid/ask but have last price, try to get bid/ask from a preview
  if ((currentBid === 0 || currentAsk === 0) && lastPrice > 0) {
    console.log('Attempting to get bid/ask from order preview...\n');
    try {
      // Try a preview with last price to see if we can extract bid/ask from response
      const previewResponse = await etradeClient.previewOrder({
        accountIdKey,
        symbol: 'RGTI',
        securityType: 'EQ',
        orderAction: 'SELL_SHORT',
        clientOrderId: `temp-${Date.now()}`,
        priceType: 'LIMIT',
        quantity: 1,
        limitPrice: lastPrice,
        orderTerm: 'GOOD_FOR_DAY',
        marketSession: 'EXTENDED',
      });
      
      // Check if preview response has bid/ask info
      const order = previewResponse?.Order?.[0];
      if (order) {
        // Preview response might have netBid/netAsk, but those are for the order, not market
        // Try using last price as fallback for both if we don't have bid/ask
        if (currentBid === 0) {
          currentBid = lastPrice;
          console.log(`Using last price (${lastPrice}) as bid fallback`);
        }
        if (currentAsk === 0) {
          currentAsk = lastPrice;
          console.log(`Using last price (${lastPrice}) as ask fallback`);
        }
      }
    } catch (error: any) {
      console.warn(`Could not get bid/ask from preview: ${error.message}`);
    }
  }

  if (currentBid === 0 || currentAsk === 0) {
    console.warn('Warning: Could not get reliable bid/ask prices. Bid/ask orders will be skipped.\n');
  }

  const orderSpecs = [
    {
      name: 'MARKET',
      orderType: 'MARKET' as const,
      limitPrice: undefined as number | undefined,
      marketSession: 'REGULAR' as const, // MARKET orders must use REGULAR session
    },
    {
      name: 'LIMIT $16.54',
      orderType: 'LIMIT' as const,
      limitPrice: 16.54,
      marketSession: 'EXTENDED' as const,
    },
    {
      name: 'LIMIT $16.72',
      orderType: 'LIMIT' as const,
      limitPrice: 16.72,
      marketSession: 'EXTENDED' as const,
    },
  ];

  // Add bid order if available
  if (currentBid > 0) {
    orderSpecs.push({
      name: `LIMIT $${currentBid.toFixed(2)} (current bid)`,
      orderType: 'LIMIT' as const,
      limitPrice: currentBid,
      marketSession: 'EXTENDED' as const,
    });
  } else {
    console.log('Skipping bid order - bid price not available');
  }

  // Add ask order if available
  if (currentAsk > 0) {
    orderSpecs.push({
      name: `LIMIT $${currentAsk.toFixed(2)} (current ask)`,
      orderType: 'LIMIT' as const,
      limitPrice: currentAsk,
      marketSession: 'EXTENDED' as const,
    });
  } else {
    console.log('Skipping ask order - ask price not available');
  }

  console.log(`Creating and placing ${orderSpecs.length} RGTI short sell orders...\n`);

  const results: Array<{ name: string; success: boolean; error?: string; orderId?: string }> = [];

  for (const orderSpec of orderSpecs) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Order: SELL_SHORT 1 share of RGTI - ${orderSpec.name}`);
    console.log('='.repeat(60));

    try {
      // Create order in database first
      const order = await orderService.createOrder({
        accountId: accountIdKey,
        symbol: 'RGTI',
        securityType: 'EQUITY',
        optionSymbol: undefined,
        optionType: undefined,
        strikePrice: undefined,
        expirationDate: undefined,
        action: 'SELL_SHORT',
        orderType: orderSpec.orderType,
        quantity: 1,
        limitPrice: orderSpec.limitPrice,
        stopPrice: undefined,
        preferredDuration: 'DAY',
        actualDuration: 'DAY',
        requiresDaily: false,
        sessionTime: orderSpec.marketSession || 'EXTENDED',
        scheduledFor: undefined,
        scheduleEnabled: false,
        scheduleFrequency: 'DAILY',
        status: 'PENDING',
        etradeOrderId: undefined,
        submittedAt: undefined,
        filledAt: undefined,
        cancelledAt: undefined,
        expiresAt: undefined,
        lastError: undefined,
        retryCount: 0,
        maxRetries: 3,
        notes: `Manual order: ${orderSpec.name}`,
      });

      console.log(`Created order in database: ${order.id}`);

      // Execute the order
      const schedulerId = `manual-rgti-${Date.now()}`;
      const success = await orderExecutor.executeOrder(order, schedulerId);

      if (success) {
        console.log(`✓ Order placed successfully: ${orderSpec.name}`);
        results.push({ name: orderSpec.name, success: true, orderId: order.id });
      } else {
        console.log(`✗ Order failed: ${orderSpec.name}`);
        results.push({ name: orderSpec.name, success: false, error: 'Execution returned false', orderId: order.id });
      }
    } catch (error: any) {
      const errorMessage = error?.message || 'Unknown error';
      console.error(`✗ Order failed: ${orderSpec.name}`);
      console.error(`  Error: ${errorMessage}`);
      results.push({ name: orderSpec.name, success: false, error: errorMessage });
    }
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('SUMMARY');
  console.log('='.repeat(60));
  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  console.log(`Total orders: ${results.length}`);
  console.log(`Successful: ${successful}`);
  console.log(`Failed: ${failed}\n`);

  for (const result of results) {
    if (result.success) {
      console.log(`✓ ${result.name}: SUCCESS`);
      if (result.orderId) console.log(`  Order ID: ${result.orderId}`);
    } else {
      console.log(`✗ ${result.name}: FAILED`);
      if (result.orderId) console.log(`  Order ID: ${result.orderId}`);
      if (result.error) {
        console.log(`  Error: ${result.error}`);
      }
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

sendRGTIOrdersNow().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
