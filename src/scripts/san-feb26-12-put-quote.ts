/**
 * Fetches and prints bid/ask sizes, OI, and volume for SAN Feb 26 $12 put.
 * Usage: npx tsx src/scripts/san-feb26-12-put-quote.ts
 */
import { ETradeClient } from '../server/services/etrade-client.js';
import type { ETradeCredentials } from '../shared/types/index.js';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const SYMBOL = 'SAN';
const EXPIRY_YEAR = 2026;
const EXPIRY_MONTH = 2;
const EXPIRY_DAY = 26;
const STRIKE = 12;

/** Day of month of the third Friday (standard monthly opex). */
function thirdFriday(year: number, month: number): number {
  const first = new Date(year, month - 1, 1);
  const dow = first.getDay(); // 0 Sun .. 5 Fri .. 6 Sat
  const daysUntilFirstFri = (5 - dow + 7) % 7;
  const firstFriday = 1 + daysUntilFirstFri;
  return firstFriday + 14;
}

async function main() {
  const isSandbox = process.env.ETRADE_SANDBOX === 'true';
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
    console.error('Missing E*TRADE consumer key/secret. Set ETRADE_CONSUMER_KEY and ETRADE_CONSUMER_SECRET (or sandbox equivalents).');
    process.exit(1);
  }
  if (!credentials.accessToken || !credentials.accessTokenSecret) {
    console.error('Missing E*TRADE access tokens. Run the OAuth flow first.');
    process.exit(1);
  }

  const client = new ETradeClient(credentials, isSandbox);

  // 0) Get SAN option expiry dates; prefer Feb 26 if present, else Feb 2026 monthly opex (third Friday)
  const expireDates = await client.getOptionExpireDates(SYMBOL);
  if (!expireDates?.length) {
    console.error('No option expiry dates found for SAN.');
    process.exit(1);
  }
  const feb26 = expireDates.find(
    (d) => d.year === EXPIRY_YEAR && d.month === EXPIRY_MONTH && d.day === EXPIRY_DAY
  );
  const feb2026 = expireDates.filter((d) => d.year === EXPIRY_YEAR && d.month === EXPIRY_MONTH);
  const monthlyOpexDay = thirdFriday(EXPIRY_YEAR, EXPIRY_MONTH);
  const febMonthly = feb2026.find((d) => d.day === monthlyOpexDay);
  const expiry = feb26 ?? febMonthly ?? feb2026[0];
  if (!expiry) {
    console.error('No Feb 2026 expiry for SAN. Available expiries (next 10):');
    expireDates.slice(0, 10).forEach((d) =>
      console.error(`  ${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`)
    );
    process.exit(1);
  }
  const { year: y, month: m, day: d } = expiry;
  console.log(`Using expiry: ${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}${febMonthly && !feb26 ? ' (Feb monthly opex)' : ''}\n`);

  // 1) Get option chain for SAN and find $12 put (OI + volume). Use strikePriceNear=12 so $12 is in range.
  const chain = await client.getOptionChainForExpiryWithStrikeNear(SYMBOL, y, m, d, STRIKE);
  const row = chain.find((p) => Math.round(p.strikePrice) === STRIKE);
  if (!row?.put) {
    console.error(`SAN ${y}-${m}-${d} $${STRIKE} put not found in chain. Available strikes near ${STRIKE}:`);
    chain.slice(0, 20).forEach((p) => console.error(`  strike ${p.strikePrice} put: ${p.put ? 'yes' : 'no'}`));
    process.exit(1);
  }

  const put = row.put;
  console.log('--- SAN Feb 26 $12 Put (from option chain) ---');
  console.log('Open Interest:', put.openInterest.toLocaleString());
  console.log('Volume (today):', put.volume.toLocaleString());
  console.log('Bid:', put.bid, '| Ask:', put.ask);
  console.log('OSI Key:', put.osiKey);

  // 2) Get quote for this option to retrieve bid size and ask size (contracts at bid/ask)
  if (!put.osiKey) {
    console.log('\nNo OSI key; skipping quote (bid/ask size).');
    process.exit(0);
  }

  const quotes = await client.getQuote([put.osiKey]);
  const raw = quotes?.[0] as any;
  const q = raw?.All ?? raw;
  const bidSize = q?.bidSize ?? null;
  const askSize = q?.askSize ?? null;
  const bid = q?.bid ?? null;
  const ask = q?.ask ?? null;
  const totalVolume = q?.totalVolume ?? null;

  console.log('\n--- Quote (bid/ask size in contracts) ---');
  console.log('Bid size (contracts at bid):', bidSize != null ? bidSize : 'N/A');
  console.log('Ask size (contracts at ask):', askSize != null ? askSize : 'N/A');
  if (bid != null || ask != null) console.log('Bid:', bid, '| Ask:', ask);
  if (totalVolume != null) console.log('Quote totalVolume:', totalVolume);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
