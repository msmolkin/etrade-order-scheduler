import { ETradeClient } from '../server/services/etrade-client.js';
import type { ETradeCredentials } from '../shared/types/index.js';
import dotenv from 'dotenv';

dotenv.config();

async function findCoveredCallCandidates() {
  const isSandbox = process.env.ETRADE_SANDBOX === 'true';
  console.log('=== Covered Call Candidates Scan ===\n');
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
    console.error('ERROR: Missing E*TRADE consumer key/secret.');
    process.exit(1);
  }
  if (!credentials.accessToken || !credentials.accessTokenSecret) {
    console.error('ERROR: Missing E*TRADE access token/secret.');
    console.error('Please run the OAuth flow first.');
    process.exit(1);
  }

  const client = new ETradeClient(credentials, isSandbox);

  try {
    console.log('Step 1: Fetching accounts...');
    const accounts = await client.getAccounts();
    if (!accounts || accounts.length === 0) {
      console.error('ERROR: No accounts found.');
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
      console.error('ERROR: No active accounts found.');
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
        console.log(
          `Available account IDs: ${activeAccounts.map((a: any) => a.accountId).join(', ')}`
        );
        console.log(`Using first active account as fallback`);
      }
    }

    const activeAccount = matchingAccount ?? activeAccounts[0];
    const accountIdKey = activeAccount.accountIdKey;
    console.log(`\nUsing account: ${activeAccount.accountName || activeAccount.accountDesc}`);
    console.log(`Account ID: ${activeAccount.accountId}`);
    console.log(`Account Key: ${accountIdKey}\n`);

    console.log('Step 2: Fetching portfolio (positions)...');
    const portfolio = await client.getPortfolio(accountIdKey);

    const positionsRaw =
      portfolio?.AccountPortfolio?.[0]?.Position ??
      portfolio?.AccountPortfolio?.Position ??
      portfolio?.accountPortfolio?.[0]?.position ??
      portfolio?.accountPortfolio?.position ??
      [];
    const positions = Array.isArray(positionsRaw) ? positionsRaw : [positionsRaw];

    type UnderlyingInfo = {
      qty: number;
      hasShortOptions: boolean;
      hasOpenShortCalls: boolean;
    };

    const bySymbol = new Map<string, UnderlyingInfo>();

    function ensureSymbol(sym: string): UnderlyingInfo {
      const key = sym.toUpperCase();
      let entry = bySymbol.get(key);
      if (!entry) {
        entry = { qty: 0, hasShortOptions: false, hasOpenShortCalls: false };
        bySymbol.set(key, entry);
      }
      return entry;
    }

    // Parse positions
    for (const pos of positions) {
      if (!pos) continue;
      const product = pos.Product ?? pos.product ?? {};
      const sym = (product.symbol ?? product.Symbol ?? pos.symbol) as string | undefined;
      const secType = (product.securityType ?? product.SecurityType ?? pos.securityType) as
        | string
        | undefined;
      const qtyVal =
        pos.quantity ??
        pos.Quantity ??
        pos.positionQuantity ??
        pos.longQty ??
        pos.LongQty ??
        0;
      const qty = Number(qtyVal) || 0;

      if (!sym || !secType) continue;
      const key = sym.toUpperCase();
      const info = ensureSymbol(key);

      if (secType.toUpperCase() === 'OPTN') {
        // Treat negative quantity as short options position
        if (qty < 0) {
          info.hasShortOptions = true;
        }
      } else {
        // Non-option: treat positive quantity as long shares
        if (qty > 0) {
          info.qty += qty;
        }
      }
    }

    console.log('Step 3: Fetching open orders...');
    const openOrders = await client.listOrders(accountIdKey, 'OPEN');

    for (const order of openOrders) {
      if (!order) continue;
      const detailsArray =
        order.OrderDetail ??
        order.orderDetail ??
        order.Details?.OrderDetail ??
        order.details?.orderDetail ??
        [];
      const orderDetails = Array.isArray(detailsArray) ? detailsArray : [detailsArray];

      for (const od of orderDetails) {
        const instrumentsRaw = od.Instrument ?? od.instrument ?? [];
        const instruments = Array.isArray(instrumentsRaw) ? instrumentsRaw : [instrumentsRaw];

        for (const ins of instruments) {
          const product = ins.Product ?? ins.product ?? {};
          const sym = (product.symbol ?? product.Symbol ?? ins.symbol) as string | undefined;
          const secType = (product.securityType ?? product.SecurityType ?? ins.securityType) as
            | string
            | undefined;
          const callPut = (product.callPut ?? product.CallPut ?? ins.callPut) as
            | string
            | undefined;
          const action = (ins.orderAction ?? ins.OrderAction ?? od.orderAction) as
            | string
            | undefined;

          if (!sym || !secType) continue;
          const key = sym.toUpperCase();
          const info = ensureSymbol(key);

          if (secType.toUpperCase() === 'OPTN') {
            // Any option orders count as \"hasShortOptions\" if they are opening shorts
            if (action && ['SELL_OPEN', 'SELL_SHORT'].includes(action.toUpperCase())) {
              info.hasShortOptions = true;
              if (callPut && callPut.toUpperCase() === 'CALL') {
                info.hasOpenShortCalls = true;
              }
            }
          }
        }
      }
    }

    console.log('\nStep 4: Computing covered-call candidates (>=100 shares, no short options, no open short calls)...\n');

    const candidates = Array.from(bySymbol.entries())
      .filter(([, info]) => info.qty >= 100 && !info.hasShortOptions && !info.hasOpenShortCalls)
      .sort((a, b) => b[1].qty - a[1].qty);

    if (candidates.length === 0) {
      console.log('No symbols found that satisfy all conditions.');
    } else {
      console.log('Symbol    Qty    HasShortOptions    HasOpenShortCalls');
      console.log('───────────────────────────────────────────────────────');
      for (const [sym, info] of candidates) {
        console.log(
          `${sym.padEnd(8)} ${String(info.qty).padEnd(6)} ${String(info.hasShortOptions).padEnd(
            17
          )} ${String(info.hasOpenShortCalls)}`
        );
      }
      console.log('\nTop candidates:');
      candidates.slice(0, 5).forEach(([sym, info], idx) => {
        console.log(`  ${idx + 1}. ${sym} (${info.qty} shares)`);
      });
    }

    console.log('\nScan complete.');
    process.exit(0);
  } catch (err: any) {
    console.error('\nERROR running covered-call candidates scan:', err.message);
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', JSON.stringify(err.response.data, null, 2));
    }
    process.exit(1);
  }
}

findCoveredCallCandidates();

