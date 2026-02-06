import { ETradeClient } from '../server/services/etrade-client.js';
import type { ETradeCredentials } from '../shared/types/index.js';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

/**
 * Sends a limit order to buy 30 shares of SLV at $77.50.
 * 
 * LIMITATION: The E*TRADE REST API does NOT support overnight orders (8pm–4am ET).
 * The API only accepts marketSession: REGULAR (9:30am–4pm) or EXTENDED (7am–8pm).
 * 
 * The website uses marketSession "3" for overnight, but this is only available
 * through their internal web API, not the public REST API.
 * 
 * This script uses EXTENDED session (7am–8pm ET). For true overnight orders,
 * you must use the E*TRADE website directly.
 * 
 * Preview is required; place is called with the preview ID.
 */
async function sendSlvOvernightOrder() {
  console.log('=== SLV Order: BUY 30 shares @ $77.50 (EXTENDED session 7am–8pm ET) ===\n');
  console.log('NOTE: REST API does not support overnight (8pm–4am). Using EXTENDED (7am–8pm).\n');

  const credentials: ETradeCredentials = {
    consumerKey: process.env.ETRADE_CONSUMER_KEY!,
    consumerSecret: process.env.ETRADE_CONSUMER_SECRET!,
    accessToken: process.env.ETRADE_ACCESS_TOKEN,
    accessTokenSecret: process.env.ETRADE_ACCESS_TOKEN_SECRET,
  };

  if (!credentials.consumerKey || !credentials.consumerSecret) {
    console.error('ERROR: Missing ETRADE_CONSUMER_KEY or ETRADE_CONSUMER_SECRET');
    process.exit(1);
  }

  if (!credentials.accessToken || !credentials.accessTokenSecret) {
    console.error('ERROR: Missing ETRADE_ACCESS_TOKEN or ETRADE_ACCESS_TOKEN_SECRET');
    console.error('Please run the OAuth flow first to get access tokens.');
    process.exit(1);
  }

  const client = new ETradeClient(credentials, false);

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
    }
    const activeAccount = matchingAccount ?? activeAccounts[0];
    const accountIdKey = activeAccount.accountIdKey;
    console.log(`Using account: ${activeAccount.accountName || activeAccount.accountDesc} (${activeAccount.accountId})\n`);

    const orderRequest = {
      accountIdKey,
      symbol: 'SLV',
      securityType: 'EQ' as const,
      orderAction: 'BUY' as const,
      priceType: 'LIMIT' as const,
      quantity: 30,
      limitPrice: 77.5,
      orderTerm: 'GOOD_FOR_DAY' as const,
      marketSession: 'EXTENDED' as const,
      clientOrderId: `slv${Date.now()}`.slice(0, 20),
    };

    console.log('Step 2: Order details');
    console.log('  Symbol:       SLV');
    console.log('  Action:       BUY');
    console.log('  Quantity:     30 shares');
    console.log('  Limit Price:  $77.50');
    console.log('  Session:      EXTENDED (7am–8pm ET only; overnight 8pm–4am not supported by REST API)');
    console.log('  Order Term:  GOOD_FOR_DAY\n');

    console.log('Step 3: Previewing and placing order...');
    const response = await client.placeOrder(orderRequest);

    const orderIds = (response as any).OrderIds;
    if (orderIds && orderIds.length > 0) {
      console.log(`\n✓ Order placed. E*TRADE Order ID: ${orderIds[0].orderId}`);
    } else {
      console.log('\n✓ Order response:', JSON.stringify(response, null, 2));
    }

    process.exit(0);
  } catch (error: any) {
    console.error('\n=== ORDER PLACEMENT FAILED ===');
    console.error('Error:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Response:', JSON.stringify(error.response.data, null, 2));
    }
    process.exit(1);
  }
}

sendSlvOvernightOrder();
