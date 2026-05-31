/**
 * Test script: sell to close 1 SNDK May 15 2026 $800 CALL @ $16.00 limit.
 * Uses preview only (no placement) to verify the request shape is correct.
 */
import { ETradeClient } from '../server/services/etrade-client.js';
import type { ETradeCredentials } from '../shared/types/index.js';
import dotenv from 'dotenv';

dotenv.config({ quiet: true } as any);

async function main() {
  const isSandbox = process.env.ETRADE_SANDBOX === 'true';
  console.log(`Mode: ${isSandbox ? 'SANDBOX' : 'PRODUCTION'}\n`);

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

  if (!credentials.accessToken || !credentials.accessTokenSecret) {
    console.error('Missing access tokens. Run OAuth flow first.');
    process.exit(1);
  }

  const client = new ETradeClient(credentials, isSandbox);

  // Get account
  const accounts = await client.getAccounts();
  const active = accounts.filter((a: any) => a.accountStatus === 'ACTIVE');
  const accountSuffix = process.env.ACCOUNT;
  const account = accountSuffix
    ? active.find((a: any) => String(a.accountId).endsWith(accountSuffix)) ?? active[0]
    : active[0];
  const accountIdKey = account.accountIdKey;
  console.log(`Account: ${account.accountId} (${account.accountName || account.accountDesc})\n`);

  // Step 1: Try to look up the OSI key from the chain
  console.log('Step 1: Looking up OSI key from option chain...');
  let osiKey: string | null = null;
  try {
    osiKey = await client.getOptionOsiKey('SNDK', 2026, 5, 15, 'CALL', 800);
    console.log(`  OSI key from chain: ${osiKey ?? 'NOT FOUND'}`);
  } catch (err: any) {
    console.log(`  Chain lookup error: ${err.message}`);
  }

  // Step 2: If no OSI key, construct one manually (OCC format)
  if (!osiKey) {
    // OCC format: SNDK  260515C00800000
    osiKey = 'SNDK  260515C00800000';
    console.log(`  Using constructed OSI: ${osiKey}`);
  }

  // Step 3: Preview the order
  console.log('\nStep 2: Previewing SELL_CLOSE order...');
  const request = {
    accountIdKey,
    symbol: 'SNDK',
    securityType: 'OPTN' as const,
    productId: { symbol: osiKey, typeCode: 'OPTION' as const },
    callPut: 'CALL' as const,
    expiryYear: 2026,
    expiryMonth: 5,
    expiryDay: 15,
    strikePrice: 800,
    orderAction: 'SELL_CLOSE' as const,
    priceType: 'LIMIT' as const,
    limitPrice: 16.00,
    quantity: 1,
    orderTerm: 'GOOD_FOR_DAY' as const,
    marketSession: 'REGULAR' as const,
    clientOrderId: `sndk${Date.now()}`,
  };

  console.log('\nRequest:', JSON.stringify(request, null, 2));

  try {
    const preview = await client.previewOrder(request);
    console.log('\n✓ Preview successful!');
    console.log(JSON.stringify(preview, null, 2));

    // If preview works, optionally place
    if (process.env.PLACE_ORDER === 'true') {
      console.log('\nStep 3: Placing order...');
      const result = await client.placeOrder(request);
      console.log('\n✓ Order placed!');
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('\nSet PLACE_ORDER=true to actually place the order.');
    }
  } catch (err: any) {
    console.error('\n✗ Error:', err.message);
    if (err.response?.data) {
      console.error('Response data:', JSON.stringify(err.response.data, null, 2));
    }
  }
}

main().catch(console.error);
