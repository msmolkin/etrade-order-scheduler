import { ETradeClient } from '../server/services/etrade-client.js';
import type { ETradeCredentials } from '../shared/types/index.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

function buildOptionSymbol(
  underlying: string,
  expirationYYMMDD: string,
  optionType: 'C' | 'P',
  strike: number
): string {
  const paddedUnderlying = underlying.padEnd(6, '-');
  const strikeThousands = Math.round(strike * 1000);
  const paddedStrike = strikeThousands.toString().padStart(8, '0');
  return `${paddedUnderlying}${expirationYYMMDD}${optionType}${paddedStrike}`;
}

async function executeXomOrder() {
  console.log('=== XOM Call Option Sell Order Execution ===\n');

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
    const matchingAccount = accountNickname
      ? activeAccounts.find((acc: any) => acc.accountId.endsWith(accountNickname))
      : activeAccounts.find((acc: any) => acc.accountId.endsWith('[REDACTED]'));
    const activeAccount = matchingAccount ?? activeAccounts[0];
    const accountIdKey = activeAccount.accountIdKey;
    console.log(`Using account: ${activeAccount.accountName || activeAccount.accountDesc}`);
    console.log(`Account Key: ${accountIdKey}\n`);

    // Step 2: Build the option order
    console.log('Step 2: Building XOM call option order...');
    
    const optionSymbol = buildOptionSymbol('XOM', '260130', 'C', 140);
    console.log(`  Underlying: XOM`);
    console.log(`  Option Type: CALL`);
    console.log(`  Strike Price: $140`);
    console.log(`  Expiration: January 30, 2026`);
    console.log(`  Option Symbol: ${optionSymbol}`);
    console.log(`  Action: SELL`);
    console.log(`  Quantity: 1 contract`);
    console.log(`  Limit Price: $55.00 per share\n`);

    // E*TRADE option preview expects underlying symbol + callPut + expiry + strike (not full option symbol).
    const orderRequest = {
      accountIdKey: accountIdKey,
      symbol: 'XOM',
      securityType: 'OPTN' as const,
      callPut: 'CALL' as const,
      expiryYear: 2026,
      expiryMonth: 1,
      expiryDay: 30,
      strikePrice: 140,
      orderAction: 'SELL_OPEN' as const,
      priceType: 'LIMIT' as const,
      quantity: 1,
      limitPrice: 55.00,
      orderTerm: 'GOOD_FOR_DAY' as const,
      marketSession: 'REGULAR' as const,
      clientOrderId: `xom${Date.now()}`, // ≤20 alphanumeric (E*TRADE)
    };

    // Step 3: Place the order
    console.log('Step 3: Placing order with E*TRADE...');
    console.log('This will go through preview and then place the order.\n');

    const response = await client.placeOrder(orderRequest);

    console.log('\n=== ORDER SUCCESSFULLY PLACED ===');
    console.log('Response:', JSON.stringify(response, null, 2));
    
    // Extract order ID if available
    const orderIds = (response as any).OrderIds;
    if (orderIds && orderIds.length > 0) {
      console.log('\n✓ E*TRADE Order ID:', orderIds[0].orderId);
    }

    console.log('\nOrder placement complete!');
    process.exit(0);

  } catch (error: any) {
    console.error('\n=== ORDER PLACEMENT FAILED ===');
    console.error('Error:', error.message);
    
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Response data:', JSON.stringify(error.response.data, null, 2));
    }
    
    process.exit(1);
  }
}

// Run the script
executeXomOrder();
