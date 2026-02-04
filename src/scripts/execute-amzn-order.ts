import { ETradeClient } from '../server/services/etrade-client.js';
import type { ETradeCredentials } from '../shared/types/index.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function executeAmznOrder() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     AMZN Market Data & Market Buy Order                  ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // Check sandbox mode
  const isSandbox = process.env.ETRADE_SANDBOX === 'true';
  console.log(`Mode: ${isSandbox ? 'SANDBOX (Testing)' : 'PRODUCTION (Live Trading)'}\n`);

  // Initialize E*TRADE client with appropriate credentials
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
  const baseUrl = isSandbox ? 'https://apisb.etrade.com' : 'https://api.etrade.com';

  try {
    // Step 1: Get account information
    console.log('Step 1: Fetching account information...');
    const accounts = await client.getAccounts();

    if (!accounts || accounts.length === 0) {
      console.error('ERROR: No accounts found');
      process.exit(1);
    }

    console.log(`Found ${accounts.length} account(s):\n`);
    accounts.forEach((account, index) => {
      console.log(`  [${index}] ${account.accountName || account.accountDesc}`);
      console.log(`      Account ID: ${account.accountId}`);
      console.log(`      Account Key: ${account.accountIdKey}`);
      console.log(`      Type: ${account.accountType}`);
      console.log(`      Status: ${account.accountStatus}\n`);
    });

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
    console.log(`Account Key: ${accountIdKey}\n`);

    // Step 2: Fetch current market data for AMZN
    console.log('Step 2: Fetching current market data for AMZN...\n');
    
    let quote: any = null;
    let quoteAttempts = 0;
    const maxQuoteAttempts = 3;
    
    while (quoteAttempts < maxQuoteAttempts && !quote) {
      try {
        const quotes = await client.getQuote(['AMZN']);
        if (quotes && quotes.length > 0) {
          quote = quotes[0];
          break;
        }
      } catch (error: any) {
        console.warn(`Warning: Could not fetch quote (attempt ${quoteAttempts + 1}): ${error.message}`);
      }
      
      quoteAttempts++;
      if (quoteAttempts < maxQuoteAttempts && !quote) {
        console.log('Retrying quote fetch in 1 second...\n');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    if (!quote) {
      console.error('ERROR: Could not fetch market data for AMZN after multiple attempts');
      process.exit(1);
    }

    // Extract market data from quote.All (E*TRADE API structure)
    const quoteData = quote.All || quote;
    const currentPrice = quoteData.lastTrade || quoteData.previousClose || 0;
    const bid = quoteData.bid || 0;
    const ask = quoteData.ask || 0;
    const bidSize = quoteData.bidSize || 0;
    const askSize = quoteData.askSize || 0;
    const volume = quoteData.totalVolume || quoteData.previousDayVolume || 0;
    const high = quoteData.high || 0;
    const low = quoteData.low || 0;
    const open = quoteData.open || 0;
    const close = quoteData.previousClose || 0;
    const change = quoteData.changeClose || 0;
    const changePct = quoteData.changeClosePercentage || 0;

    // Display market data
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║              AMZN MARKET DATA                             ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    
    console.log('  ┌─────────────────────────────────────────────────────┐');
    console.log('  │  Current Market Price                               │');
    console.log('  ├─────────────────────────────────────────────────────┤');
    console.log(`  │  Last Price:        $${currentPrice.toFixed(2).padStart(10)}              │`);
    if (open > 0) {
      console.log(`  │  Open:              $${open.toFixed(2).padStart(10)}              │`);
    }
    if (high > 0) {
      console.log(`  │  High:              $${high.toFixed(2).padStart(10)}              │`);
    }
    if (low > 0) {
      console.log(`  │  Low:               $${low.toFixed(2).padStart(10)}              │`);
    }
    if (change !== 0) {
      const changeSign = change >= 0 ? '+' : '';
      const changePctSign = changePct >= 0 ? '+' : '';
      console.log(`  │  Change:            ${changeSign}$${change.toFixed(2).padStart(9)} (${changePctSign}${changePct.toFixed(2)}%)    │`);
    }
    console.log('  └─────────────────────────────────────────────────────┘\n');

    console.log('  ┌─────────────────────────────────────────────────────┐');
    console.log('  │  Bid / Ask & Market Depth                           │');
    console.log('  ├─────────────────────────────────────────────────────┤');
    console.log(`  │  Bid:               $${bid.toFixed(2).padStart(10)}              │`);
    console.log(`  │  Bid Size:          ${bidSize.toLocaleString().padStart(10)} shares          │`);
    console.log(`  │  Ask:               $${ask.toFixed(2).padStart(10)}              │`);
    console.log(`  │  Ask Size:          ${askSize.toLocaleString().padStart(10)} shares          │`);
    if (bid > 0 && ask > 0) {
      const spread = ask - bid;
      const spreadPct = ((spread / bid) * 100).toFixed(4);
      console.log(`  │  Spread:            $${spread.toFixed(2).padStart(10)} (${spreadPct}%)        │`);
    }
    console.log('  └─────────────────────────────────────────────────────┘\n');

    if (volume > 0) {
      console.log('  ┌─────────────────────────────────────────────────────┐');
      console.log('  │  Volume                                             │');
      console.log('  ├─────────────────────────────────────────────────────┤');
      console.log(`  │  Volume:            ${volume.toLocaleString().padStart(15)} shares          │`);
      console.log('  └─────────────────────────────────────────────────────┘\n');
    }

    // Step 3: Build the market buy order request
    console.log('Step 3: Building market buy order request...\n');
    
    const orderRequest = {
      accountIdKey: accountIdKey,
      symbol: 'AMZN',
      securityType: 'EQ' as const,
      orderAction: 'BUY' as const,
      priceType: 'MARKET' as const,
      quantity: 1,
      orderTerm: 'GOOD_FOR_DAY' as const,
      marketSession: 'REGULAR' as const,
      clientOrderId: `amzn${Date.now()}`, // ≤20 alphanumeric (E*TRADE)
    };

    console.log('  ┌─────────────────────────────────────────────────────┐');
    console.log('  │              ORDER DETAILS                         │');
    console.log('  ├─────────────────────────────────────────────────────┤');
    console.log(`  │  Symbol:            AMZN                            │`);
    console.log(`  │  Action:            BUY                             │`);
    console.log(`  │  Quantity:          1 share                          │`);
    console.log(`  │  Price Type:        MARKET                          │`);
    console.log(`  │  Order Term:        GOOD_FOR_DAY                    │`);
    console.log(`  │  Session:           REGULAR                         │`);
    console.log(`  │  Client Order ID:   ${orderRequest.clientOrderId.padEnd(20)}  │`);
    console.log('  └─────────────────────────────────────────────────────┘\n');

    // Step 4: Place the order
    const skipPreview = process.env.SKIP_PREVIEW === 'true';
    
    if (skipPreview) {
      console.log('Step 4: Attempting direct order placement (skipping preview)...');
      console.log(`Making POST request to ${baseUrl}/v1/accounts/${accountIdKey}/orders/place\n`);
    } else {
      console.log('Step 4: Submitting order preview to E*TRADE...');
      console.log(`Making POST request to ${baseUrl}/v1/accounts/${accountIdKey}/orders/preview`);
      console.log('Placing order (this will preview first, then place)...\n');
    }
    
    const response = skipPreview 
      ? await client.placeOrderDirect(orderRequest)
      : await client.placeOrder(orderRequest);

    // Step 5: Order complete
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║              ORDER SUCCESSFULLY PLACED                     ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    
    console.log('Full response:', JSON.stringify(response, null, 2));
    
    // Extract order ID if available
    const orderIds = (response as any).OrderIds;
    if (orderIds && orderIds.length > 0) {
      console.log(`\n✓ E*TRADE Order ID: ${orderIds[0].orderId}`);
    }

    console.log('\n✓ Order placement complete!');
    process.exit(0);

  } catch (error: any) {
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║              ORDER PLACEMENT FAILED                        ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    
    console.error('Error:', error.message);
    
    if (error.response) {
      console.error('HTTP Status:', error.response.status);
      console.error('Response data:', JSON.stringify(error.response.data, null, 2));
    }
    
    if (error.config) {
      console.error('Failed URL:', error.config.url);
      console.error('Failed Method:', error.config.method?.toUpperCase());
    }
    
    process.exit(1);
  }
}

// Run the script
executeAmznOrder();
