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

async function executeIntcOrder() {
  console.log('=== INTC Call Option Sell Order Execution ===\n');

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

    // Step 2: Get valid expiry dates and fetch option chain to select best strike by OI
    console.log('Step 2: Fetching valid INTC option expiry dates...');
    const expireDates = await client.getOptionExpireDates('INTC');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const nextExpiry = expireDates.find(
      (d) => new Date(d.year, d.month - 1, d.day).getTime() >= today.getTime()
    );
    if (!nextExpiry) {
      console.error('ERROR: No future option expiry dates found for INTC');
      process.exit(1);
    }
    const { year: expiryYear, month: expiryMonth, day: expiryDay } = nextExpiry;
    const expiryYYMMDD = `${String(expiryYear).slice(2)}${String(expiryMonth).padStart(2, '0')}${String(expiryDay).padStart(2, '0')}`;
    const expiryLabel = new Date(expiryYear, expiryMonth - 1, expiryDay).toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
    console.log(`  Using next expiry: ${expiryLabel}\n`);

    console.log('Step 3: Fetching INTC option chain for calls...');
    const optionChain = await client.getOptionChainForExpiry('INTC', expiryYear, expiryMonth, expiryDay);

    // Filter to calls with open interest and display
    const callsWithOI = optionChain
      .filter((p) => p.call && p.call.openInterest > 0)
      .map((p) => ({
        strike: p.strikePrice,
        ...p.call!,
      }))
      .sort((a, b) => b.openInterest - a.openInterest);

    if (callsWithOI.length === 0) {
      console.error('ERROR: No calls with open interest found');
      process.exit(1);
    }

    console.log('\n┌─────────────────────────────────────────────────────────────────────────┐');
    console.log('│  INTC CALL OPTIONS - Open Interest Analysis                             │');
    console.log('└─────────────────────────────────────────────────────────────────────────┘');
    console.log('Strike Price    Open Interest    Volume    Bid      Ask      OSI Key');
    console.log('─────────────────────────────────────────────────────────────────────────────');

    // Display strikes with OI > 0, sorted by OI (highest first)
    callsWithOI.forEach((call) => {
      const strikeStr = `$${call.strike.toFixed(2)}`.padEnd(14);
      const oiStr = call.openInterest.toLocaleString().padEnd(16);
      const volStr = call.volume.toLocaleString().padEnd(10);
      const bidStr = call.bid > 0 ? `$${call.bid.toFixed(2)}` : 'N/A';
      const askStr = call.ask > 0 ? `$${call.ask.toFixed(2)}` : 'N/A';
      const osiStr = call.osiKey || 'N/A';
      console.log(`${strikeStr}${oiStr}${volStr}${bidStr.padEnd(9)}${askStr.padEnd(9)}${osiStr}`);
    });
    console.log('─────────────────────────────────────────────────────────────────────────────\n');

    // Select strike with highest open interest
    const selectedCall = callsWithOI[0];
    const selectedStrike = selectedCall.strike;
    const osiKey = selectedCall.osiKey;

    console.log(`Selected strike: $${selectedStrike.toFixed(2)} (Highest OI: ${selectedCall.openInterest.toLocaleString()})\n`);

    const optionSymbol = buildOptionSymbol('INTC', expiryYYMMDD, 'C', selectedStrike);
    console.log(`  Underlying: INTC`);
    console.log(`  Option Type: CALL`);
    console.log(`  Strike Price: $${selectedStrike.toFixed(2)}`);
    console.log(`  Expiration: ${expiryLabel}`);
    console.log(`  Option Symbol (built): ${optionSymbol}`);
    if (osiKey) console.log(`  OSI Key (from API): ${osiKey}`);
    console.log(`  Open Interest: ${selectedCall.openInterest.toLocaleString()}`);
    console.log(`  Action: SELL`);
    console.log(`  Quantity: 1 contract`);
    console.log(`  Limit Price: $55.00 per share\n`);

    const orderRequest = {
      accountIdKey: accountIdKey,
      symbol: 'INTC',
      securityType: 'OPTN' as const,
      ...(osiKey && { productId: { symbol: osiKey, typeCode: 'OPTION' as const } }),
      callPut: 'CALL' as const,
      expiryYear,
      expiryMonth,
      expiryDay,
      strikePrice: selectedStrike,
      orderAction: 'SELL_OPEN' as const,
      priceType: 'LIMIT' as const,
      quantity: 1,
      limitPrice: 55.0,
      orderTerm: 'GOOD_FOR_DAY' as const,
      marketSession: 'REGULAR' as const,
      clientOrderId: `intc${Date.now()}`, // ≤20 alphanumeric (E*TRADE)
    };

    // Step 4: Place the order
    console.log('Step 4: Placing order with E*TRADE...');
    console.log('This will go through preview and then place the order.\n');

    const response = await client.placeOrder(orderRequest);

    console.log('\n=== ORDER SUCCESSFULLY PLACED ===');
    console.log('Response:', JSON.stringify(response, null, 2));

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
executeIntcOrder();

