import { ETradeClient } from '../server/services/etrade-client.js';
import type { ETradeCredentials } from '../shared/types/index.js';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Load environment variables
dotenv.config();

interface AccountNickname {
  nickname: string;
  accountIdKey: string;
  accountId: string;
  accountName: string;
  accountType: string;
  accountStatus: string;
}

function log(step: string, message: string, data?: any) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${step}: ${message}`);
  if (data !== undefined) {
    console.log(JSON.stringify(data, null, 2));
  }
}

function getAccountKeyByNickname(nickname: string): AccountNickname | null {
  const nicknamesPath = path.join(process.cwd(), '.account-nicknames.json');
  
  if (!fs.existsSync(nicknamesPath)) {
    return null;
  }

  const nicknames: AccountNickname[] = JSON.parse(fs.readFileSync(nicknamesPath, 'utf-8'));
  return nicknames.find(n => n.nickname === nickname) || null;
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
    const accountNickname = process.env.ACCOUNT;
    let accountIdKey: string;
    let accountName: string;

    if (accountNickname) {
      // Use nickname from ACCOUNT env var
      log('STEP 4', `Looking up account by nickname: ${accountNickname}`);
      const savedAccount = getAccountKeyByNickname(accountNickname);
      
      if (savedAccount) {
        if (savedAccount.accountStatus !== 'ACTIVE') {
          log('ERROR', `Account ${accountNickname} is not active (status: ${savedAccount.accountStatus})`);
          process.exit(1);
        }
        accountIdKey = savedAccount.accountIdKey;
        accountName = `${savedAccount.accountName} (${savedAccount.nickname})`;
        log('STEP 4', `Found account from saved nicknames ✓`);
        log('STEP 4', `Account: ${accountName}`);
        log('STEP 4', `Account ID Key: ${accountIdKey}`);
      } else {
        // Nickname not in cache, fetch from API and find by last 4 digits
        log('STEP 4', 'Nickname not cached, fetching from E*TRADE...');
        log('STEP 4', `Making GET request to ${baseUrl}/v1/accounts/list`);
        
        const accounts = await client.getAccounts();
        const matchingAccount = accounts.find((acc: any) => acc.accountId.endsWith(accountNickname));
        
        if (!matchingAccount) {
          log('ERROR', `No account found ending with "${accountNickname}"`);
          log('ERROR', 'Available accounts:');
          accounts.forEach((acc: any) => {
            console.log(`  - ${acc.accountId.slice(-4)}: ${acc.accountDesc}`);
          });
          process.exit(1);
        }
        
        if (matchingAccount.accountStatus !== 'ACTIVE') {
          log('ERROR', `Account ${accountNickname} is not active (status: ${matchingAccount.accountStatus})`);
          process.exit(1);
        }
        
        accountIdKey = matchingAccount.accountIdKey;
        accountName = `${matchingAccount.accountDesc || matchingAccount.accountName} (${accountNickname})`;
        log('STEP 4', `Found account: ${accountName} ✓`);
      }
    } else {
      // No nickname specified, fetch and use first active account
      log('STEP 4', 'No ACCOUNT specified, fetching account list from E*TRADE...');
      log('STEP 4', `Making GET request to ${baseUrl}/v1/accounts/list`);
      
      const accounts = await client.getAccounts();
      
      if (!accounts || accounts.length === 0) {
        log('ERROR', 'No accounts found');
        process.exit(1);
      }

      log('STEP 4', `Found ${accounts.length} account(s):`);
      accounts.forEach((account: any, index: number) => {
        const nickname = account.accountId.slice(-4);
        console.log(`  [${index}] ${nickname}: ${account.accountName || account.accountDesc} (${account.accountType}) - ${account.accountStatus}`);
      });

      // Use the first active account
      const activeAccount = accounts.find((acc: any) => acc.accountStatus === 'ACTIVE');
      if (!activeAccount) {
        log('ERROR', 'No active accounts found');
        process.exit(1);
      }

      accountIdKey = activeAccount.accountIdKey;
      accountName = `${activeAccount.accountName || activeAccount.accountDesc} (${activeAccount.accountId.slice(-4)})`;
      log('STEP 4', `Selected account: ${accountName}`);
      log('STEP 4', 'TIP: Use ACCOUNT=XXXX to specify an account by last 4 digits');
    }
    
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
      orderTerm: 'GOOD_UNTIL_CANCEL' as const,
      marketSession: 'REGULAR' as const,
      clientOrderId: `aapl${Date.now()}`, // ≤20 alphanumeric (E*TRADE)
    };

    console.log('  ┌─────────────────────────────────────┐');
    console.log('  │         ORDER DETAILS               │');
    console.log('  ├─────────────────────────────────────┤');
    console.log(`  │  Symbol:        AAPL                │`);
    console.log(`  │  Action:        BUY                 │`);
    console.log(`  │  Quantity:      1 share             │`);
    console.log(`  │  Price Type:    LIMIT               │`);
    console.log(`  │  Limit Price:   $10.00              │`);
    console.log(`  │  Order Term:    GOOD_UNTIL_CANCEL   │`);
    console.log(`  │  Session:       REGULAR             │`);
    console.log('  └─────────────────────────────────────┘');
    
    log('STEP 5', 'Order request built ✓');
    log('STEP 5', 'Full order request:', orderRequest);

    // Step 6: Place the order
    const skipPreview = process.env.SKIP_PREVIEW === 'true';
    
    if (skipPreview) {
      log('STEP 6', 'Attempting direct order placement (skipping preview)...');
      log('STEP 6', `Making POST request to ${baseUrl}/v1/accounts/${accountIdKey}/orders/place`);
    } else {
      log('STEP 6', 'Submitting order preview to E*TRADE...');
      log('STEP 6', `Making POST request to ${baseUrl}/v1/accounts/${accountIdKey}/orders/preview`);
      log('STEP 7', 'Placing order (this will preview first, then place)...');
    }
    
    const response = skipPreview 
      ? await client.placeOrderDirect(orderRequest)
      : await client.placeOrder(orderRequest);

    // Step 7: Order complete
    log('STEP 7', 'Order placement response received');
    
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
