import { ETradeClient } from '../server/services/etrade-client.js';
import type { ETradeCredentials } from '../shared/types/index.js';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

type MarketSessionCandidate = string | number | null | undefined | boolean;

function printBody(obj: unknown) {
  // Per request: no logging except response body
  // Print as either raw string/XML or JSON.
  if (typeof obj === 'string') {
    process.stdout.write(obj);
    if (!obj.endsWith('\n')) process.stdout.write('\n');
    return;
  }
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function main() {
  const credentials: ETradeCredentials = {
    consumerKey: process.env.ETRADE_CONSUMER_KEY!,
    consumerSecret: process.env.ETRADE_CONSUMER_SECRET!,
    accessToken: process.env.ETRADE_ACCESS_TOKEN,
    accessTokenSecret: process.env.ETRADE_ACCESS_TOKEN_SECRET,
  };

  const client = new ETradeClient(credentials, false);
  const accounts = await client.getAccounts();
  const activeAccounts = accounts.filter((acc: any) => acc.accountStatus === 'ACTIVE');
  const accountIdKey = activeAccounts[0]?.accountIdKey;

  const explicit: MarketSessionCandidate[] = [
    // Known documented values
    'REGULAR',
    'EXTENDED',
    'regular',
    'extended',

    // Website observed values
    '3',
    3,

    // Other numeric-ish candidates
    '0',
    0,
    '1',
    1,
    '2',
    2,
    '4',
    4,
    '5',
    5,
    '6',
    6,
    '7',
    7,
    '8',
    8,
    '9',
    9,
    '10',
    10,

    // Common naming guesses
    'OVERNIGHT',
    'Overnight',
    'overnight',
    'NIGHT',
    'night',
    'AFTER_HOURS',
    'after_hours',
    'PRE_MARKET',
    'pre_market',
    'POST_MARKET',
    'post_market',
    'EXTENDED_OVERNIGHT',
    'EH_OVERNIGHT',
    'SESSION_3',
    'MARKET_SESSION_3',

    // Weird but quick to rule out
    true,
    false,
    null,
    undefined,
    '',
    ' ',
  ];

  // Also brute-force a range of numbers/strings (kept small-ish)
  const brute: MarketSessionCandidate[] = [];
  for (let i = -2; i <= 20; i++) {
    brute.push(i, String(i));
  }

  // De-dupe while preserving order (including type)
  const seen = new Set<string>();
  const candidates: MarketSessionCandidate[] = [];
  for (const v of [...explicit, ...brute]) {
    const key = `${typeof v}:${String(v)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(v);
  }

  for (const candidate of candidates) {
    try {
      const response = await client.previewOrder({
        accountIdKey,
        symbol: 'SLV',
        securityType: 'EQ',
        orderAction: 'BUY',
        clientOrderId: `ms${Date.now()}`.slice(0, 20),
        priceType: 'LIMIT',
        quantity: 1,
        limitPrice: 77.5,
        orderTerm: 'GOOD_FOR_DAY',
        marketSession: candidate as any,
      });
      printBody(response);
    } catch (e: any) {
      // Print only response body (or message if no body)
      printBody(e?.response?.data ?? e?.message ?? String(e));
    }
  }
}

main().catch((e) => {
  printBody(e?.response?.data ?? e?.message ?? String(e));
  process.exit(1);
});
