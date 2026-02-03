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

    // Step 1b: Inspect portfolio + open orders to confirm covered-call prerequisites / existing positions
    console.log('Step 1b: Checking portfolio positions and open orders (for coverage / existing shorts)...');
    try {
      const portfolio = await client.getPortfolio(accountIdKey);
      const openOrders = await client.listOrders(accountIdKey, 'OPEN');

      // Best-effort extraction of positions from PortfolioResponse (varies by format)
      const positions =
        portfolio?.AccountPortfolio?.[0]?.Position ??
        portfolio?.AccountPortfolio?.Position ??
        portfolio?.accountPortfolio?.[0]?.position ??
        portfolio?.accountPortfolio?.position ??
        [];
      const posList = Array.isArray(positions) ? positions : [positions];

      const intcEquityPos = posList.find((p: any) => {
        const sym = p?.Product?.symbol ?? p?.product?.symbol ?? p?.symbol;
        const sec = p?.Product?.securityType ?? p?.product?.securityType ?? p?.securityType;
        return String(sym).toUpperCase() === 'INTC' && String(sec).toUpperCase() !== 'OPTN';
      });
      const intcQty =
        Number(intcEquityPos?.quantity ?? intcEquityPos?.Quantity ?? intcEquityPos?.positionQuantity ?? 0) || 0;

      console.log(`  INTC equity position qty (best-effort): ${intcQty}`);
      console.log(`  Open orders count: ${openOrders.length}`);
    } catch (e: any) {
      console.log('  WARNING: Could not fetch portfolio/orders (continuing).');
      console.log(`  ${e?.message ?? e}`);
    }
    console.log('');

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
    console.log(`  Quantity: 1 contract`);
    console.log(`  Note: Next we will preview multiple order actions (no placement)\n`);

    // Step 4: Re-check positions for this specific option (in case you are already short)
    console.log('Step 4: Checking if you already hold this option (long/short) in the account...');
    try {
      const portfolio = await client.getPortfolio(accountIdKey);
      const blob = JSON.stringify(portfolio);
      const hasOsiKey = osiKey ? blob.includes(osiKey) : false;
      console.log(`  Portfolio contains OSI key ${osiKey}: ${hasOsiKey ? 'YES' : 'NO'}`);
    } catch (e: any) {
      console.log('  WARNING: Could not re-fetch portfolio for option check.');
      console.log(`  ${e?.message ?? e}`);
    }
    console.log('');

    // Step 5: Try multiple order actions via PREVIEW ONLY
    console.log('Step 4: Previewing multiple option order actions (no placement)...\n');

    type Scenario = {
      label: string;
      orderAction: 'BUY_OPEN' | 'SELL_OPEN' | 'BUY_CLOSE' | 'SELL_CLOSE';
      limitPrice: number;
      clientOrderIdPrefix: string;
    };

    const scenarios: Scenario[] = [
      { label: 'BUY_OPEN (limit $0.10)', orderAction: 'BUY_OPEN', limitPrice: 0.1, clientOrderIdPrefix: 'intcbo' },
      { label: 'SELL_OPEN (high limit)', orderAction: 'SELL_OPEN', limitPrice: 55.0, clientOrderIdPrefix: 'intcso' },
      { label: 'BUY_CLOSE (limit $0.10)', orderAction: 'BUY_CLOSE', limitPrice: 0.1, clientOrderIdPrefix: 'intcbc' },
      { label: 'SELL_CLOSE (high limit)', orderAction: 'SELL_CLOSE', limitPrice: 55.0, clientOrderIdPrefix: 'intcsc' },
    ];

    const baseRequest = {
      accountIdKey: accountIdKey,
      symbol: 'INTC',
      securityType: 'OPTN' as const,
      ...(osiKey && { productId: { symbol: osiKey, typeCode: 'OPTION' as const } }),
      callPut: 'CALL' as const,
      expiryYear,
      expiryMonth,
      expiryDay,
      strikePrice: selectedStrike,
      priceType: 'LIMIT' as const,
      quantity: 1,
      orderTerm: 'GOOD_FOR_DAY' as const,
      marketSession: 'REGULAR' as const,
    };

    for (const s of scenarios) {
      console.log('============================================================');
      console.log(`Scenario: ${s.label}`);
      console.log('============================================================');
      try {
        const preview = await client.previewOrder({
          ...baseRequest,
          orderAction: s.orderAction,
          limitPrice: s.limitPrice,
          // ≤20 alphanumeric, unique per attempt
          clientOrderId: `${s.clientOrderIdPrefix}${Date.now()}`,
        });

        const previewId = preview?.PreviewIds?.[0]?.previewId;
        console.log(`✓ PREVIEW OK for ${s.orderAction}. previewId=${previewId ?? 'unknown'}`);
      } catch (err: any) {
        const codeMatch = String(err?.response?.data ?? '').match(/<code>(\d+)<\/code>/);
        const msgMatch = String(err?.response?.data ?? '').match(/<message>([\s\S]*?)<\/message>/);
        const code = codeMatch?.[1];
        const msg = msgMatch?.[1]?.replace(/&apos;/g, "'")?.trim();
        console.log(`✗ PREVIEW FAILED for ${s.orderAction}${code ? ` (code ${code})` : ''}`);
        if (msg) console.log(`  message: ${msg}`);
      }
      console.log('');
    }

    console.log('Preview-only scenario run complete.');
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

