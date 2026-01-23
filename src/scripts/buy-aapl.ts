import { ETradeClient } from '../server/services/etrade-client.js';
import type { ETradeCredentials } from '../shared/types/index.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

function log(step: string, message: string, data?: any) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${step}: ${message}`);
  if (data !== undefined) {
    console.log(JSON.stringify(data, null, 2));
  }
}

async function buyApple() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           Buy 1 Share of AAPL at $10                       ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // Step 1: Check environment and mode
  log('STEP 1', 'Checking environment configuration...');
  
  const isSandbox = process.env.ETRADE_SANDBOX === 'true';
  log('STEP 1', `Trading mode: ${isSandbox ? 'SANDBOX (Testing)' : 'PRODUCTION (Live Trading)'}`);

  // Step 2: Load credentials
  log('STEP 2', 'Loading E*TRADE credentials...');
  
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
    log('ERROR', `Missing ${keyNames}`);
    process.exit(1);
  }
  log('STEP 2', 'Consumer key loaded: ' + credentials.consumerKey.substring(0, 8) + '...');

  if (!credentials.accessToken || !credentials.accessTokenSecret) {
    const tokenNames = isSandbox
      ? 'ETRADE_SANDBOX_ACCESS_TOKEN or ETRADE_SANDBOX_ACCESS_TOKEN_SECRET'
      : 'ETRADE_ACCESS_TOKEN or ETRADE_ACCESS_TOKEN_SECRET';
    log('ERROR', `Missing ${tokenNames}`);
    log('ERROR', 'Please run the OAuth flow first to get access tokens.');
    process.exit(1);
  }
  log('STEP 2', 'Access token loaded: ' + credentials.accessToken.substring(0, 8) + '...');
  log('STEP 2', 'Credentials loaded successfully ✓');

  // Step 3: Initialize client
  log('STEP 3', 'Initializing E*TRADE API client...');
  const client = new ETradeClient(credentials, isSandbox);
  const baseUrl = isSandbox ? 'https://apisb.etrade.com' : 'https://api.etrade.com';
  log('STEP 3', `API base URL: ${baseUrl}`);
  log('STEP 3', 'Client initialized ✓');

  try {
    // Step 4: Get account information
    log('STEP 4', 'Fetching account list from E*TRADE...');
    log('STEP 4', `Making GET request to ${baseUrl}/v1/accounts/list`);
    
    const accounts = await client.getAccounts();
    
    if (!accounts || accounts.length === 0) {
      log('ERROR', 'No accounts found');
      process.exit(1);
    }

    log('STEP 4', `Found ${accounts.length} account(s):`);
    accounts.forEach((account, index) => {
      console.log(`  [${index}] ${account.accountName || account.accountDesc} (${account.accountType}) - ${account.accountStatus}`);
    });

    // Use the first active account
    const activeAccount = accounts.find(acc => acc.accountStatus === 'ACTIVE');
    if (!activeAccount) {
      log('ERROR', 'No active accounts found');
      process.exit(1);
    }

    const accountIdKey = activeAccount.accountIdKey;
    log('STEP 4', `Selected account: ${activeAccount.accountName || activeAccount.accountDesc}`);
    log('STEP 4', `Account ID Key: ${accountIdKey} ✓`);

    // Step 5: Build the order request
    log('STEP 5', 'Building order request...');
    
    const orderRequest = {
      accountIdKey: accountIdKey,
      symbol: 'AAPL',
      securityType: 'EQ' as const,
      orderAction: 'BUY' as const,
      priceType: 'LIMIT' as const,
      quantity: 1,
      limitPrice: 10.00,
      orderTerm: 'GOOD_FOR_DAY' as const,
      marketSession: 'REGULAR' as const,
      clientOrderId: `aapl-buy-${Date.now()}`,
    };

    console.log('  ┌─────────────────────────────────────┐');
    console.log('  │         ORDER DETAILS               │');
    console.log('  ├─────────────────────────────────────┤');
    console.log(`  │  Symbol:        AAPL                │`);
    console.log(`  │  Action:        BUY                 │`);
    console.log(`  │  Quantity:      1 share             │`);
    console.log(`  │  Price Type:    LIMIT               │`);
    console.log(`  │  Limit Price:   $10.00              │`);
    console.log(`  │  Order Term:    GOOD_FOR_DAY        │`);
    console.log(`  │  Session:       REGULAR             │`);
    console.log('  └─────────────────────────────────────┘');
    
    log('STEP 5', 'Order request built ✓');
    log('STEP 5', 'Full order request:', orderRequest);

    // Step 6: Preview the order
    log('STEP 6', 'Submitting order preview to E*TRADE...');
    log('STEP 6', `Making POST request to ${baseUrl}/v1/accounts/${accountIdKey}/orders/preview`);

    // Step 7: Place the order (preview + place happens inside placeOrder)
    log('STEP 7', 'Placing order (this will preview first, then place)...');
    
    const response = await client.placeOrder(orderRequest);

    // Step 8: Order complete
    log('STEP 8', 'Order placement response received');
    
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║              ORDER SUCCESSFULLY PLACED                     ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    
    log('RESULT', 'Full response:', response);
    
    // Extract order ID if available
    const orderIds = (response as any).OrderIds;
    if (orderIds && orderIds.length > 0) {
      log('RESULT', `E*TRADE Order ID: ${orderIds[0].orderId} ✓`);
    }

    console.log('\n✓ Order placement complete!');
    process.exit(0);

  } catch (error: any) {
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║              ORDER PLACEMENT FAILED                        ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    
    log('ERROR', `Error message: ${error.message}`);
    
    if (error.response) {
      log('ERROR', `HTTP Status: ${error.response.status}`);
      log('ERROR', 'Response data:', error.response.data);
    }
    
    if (error.config) {
      log('ERROR', `Failed URL: ${error.config.url}`);
      log('ERROR', `Failed Method: ${error.config.method?.toUpperCase()}`);
    }
    
    process.exit(1);
  }
}

// Run the script
buyApple();
