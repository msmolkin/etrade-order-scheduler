import { ETradeClient } from '../server/services/etrade-client.js';
import type { ETradeCredentials } from '../shared/types/index.js';
import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_STREAM_SECONDS = 5;

const args = process.argv.slice(2);

function parseStreamSeconds(): number {
  const idx = args.findIndex((a) => a === '-s' || a === '--stream');
  if (idx === -1 || !args[idx + 1]) return DEFAULT_STREAM_SECONDS;
  const n = Number(args[idx + 1]);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_STREAM_SECONDS;
  return Math.floor(n);
}

function parseHide(): boolean {
  return args.includes('--hide');
}

async function getMicronQuote() {
  const streamSeconds = parseStreamSeconds();
  const minimal = parseHide();

  if (!minimal) {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║     Micron (MU) Market Data & Depth                        ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
  }

  const isSandbox = process.env.ETRADE_SANDBOX === 'true';
  if (!minimal) {
    console.log(`Mode: ${isSandbox ? 'SANDBOX (Testing)' : 'PRODUCTION (Live Trading)'}\n`);
  }

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
    console.error('ERROR: Missing E*TRADE credentials');
    process.exit(1);
  }

  if (!credentials.accessToken || !credentials.accessTokenSecret) {
    console.error('ERROR: Missing access tokens. Please run OAuth flow first.');
    process.exit(1);
  }

  const client = new ETradeClient(credentials, isSandbox);

  try {
    if (!minimal) console.log('Fetching Micron (MU) quote data...\n');

    const quotes = await client.getQuote(['MU']);
    
    if (!quotes || quotes.length === 0) {
      console.error('ERROR: No quote data returned for MU');
      process.exit(1);
    }

    const quote = quotes[0];
    const quoteData = quote.All || quote;

    // Extract market data
    const currentPrice = quoteData.lastTrade || quoteData.previousClose || 0;
    const bid = quoteData.bid || 0;
    const ask = quoteData.ask || 0;
    const bidSize = quoteData.bidSize || 0;
    const askSize = quoteData.askSize || 0;
    const volume = quoteData.totalVolume || quoteData.previousDayVolume || 0;
    const high = quoteData.high || 0;
    const low = quoteData.low || 0;
    const open = quoteData.open || 0;
    const close = quoteData.previousClose || 0;
    const change = quoteData.changeClose || 0;
    const changePct = quoteData.changeClosePercentage || 0;
    const companyName = quoteData.companyName || quoteData.symbolDescription || 'Micron Technology Inc.';

    // Display current price and basic market data
    if (minimal) {
      console.log(`MU ${companyName}`);
      console.log(`Last: $${currentPrice.toFixed(2)}`);
      if (open > 0) console.log(`Open: $${open.toFixed(2)}`);
      if (high > 0) console.log(`High: $${high.toFixed(2)}`);
      if (low > 0) console.log(`Low: $${low.toFixed(2)}`);
      if (close > 0) console.log(`Previous close: $${close.toFixed(2)}`);
      if (change !== 0) {
        const changeSign = change >= 0 ? '+' : '';
        const changePctSign = changePct >= 0 ? '+' : '';
        console.log(`Change: ${changeSign}$${change.toFixed(2)} (${changePctSign}${changePct.toFixed(2)}%)`);
      }
      console.log('');
    } else {
      console.log('╔════════════════════════════════════════════════════════════╗');
      console.log('║              MICRON (MU) MARKET DATA                       ║');
      console.log('╚════════════════════════════════════════════════════════════╝\n');
      console.log(`Company: ${companyName}`);
      console.log(`Symbol: MU\n`);
      console.log('  ┌─────────────────────────────────────────────────────┐');
      console.log('  │  Current Market Price                               │');
      console.log('  ├─────────────────────────────────────────────────────┤');
      console.log(`  │  Last Price:        $${currentPrice.toFixed(2).padStart(10)}              │`);
      if (open > 0) {
        console.log(`  │  Open:              $${open.toFixed(2).padStart(10)}              │`);
      }
      if (high > 0) {
        console.log(`  │  High:              $${high.toFixed(2).padStart(10)}              │`);
      }
      if (low > 0) {
        console.log(`  │  Low:               $${low.toFixed(2).padStart(10)}              │`);
      }
      if (close > 0) {
        console.log(`  │  Previous Close:   $${close.toFixed(2).padStart(10)}              │`);
      }
      if (change !== 0) {
        const changeSign = change >= 0 ? '+' : '';
        const changePctSign = changePct >= 0 ? '+' : '';
        console.log(`  │  Change:            ${changeSign}$${change.toFixed(2).padStart(9)} (${changePctSign}${changePct.toFixed(2)}%)    │`);
      }
      console.log('  └─────────────────────────────────────────────────────┘\n');
    }

    // Full quote response (important for inspection) — hidden in minimal mode
    if (!minimal) {
      console.log('╔════════════════════════════════════════════════════════════╗');
      console.log('║              FULL QUOTE RESPONSE (for inspection)          ║');
      console.log('╚════════════════════════════════════════════════════════════╝\n');
      console.log(JSON.stringify(quote, null, 2));
      console.log('\n');
    }

    // Ex-dividend date (if dividend exists)
    const exDividendDate = quoteData.exDividendDate;
    const dividend = quoteData.dividend;
    if (dividend && dividend > 0 && exDividendDate && exDividendDate > 0) {
      const exDivDate = new Date(exDividendDate * 1000);
      const formattedDate = minimal
        ? exDivDate.toLocaleDateString()
        : exDivDate.toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          });
      console.log(`Ex-dividend date: ${formattedDate}`);
    }
    if (!minimal) console.log('');

    // Stream live data
    if (!minimal) {
      const streamLabel = `STREAMING LIVE DATA (${streamSeconds} second${streamSeconds === 1 ? '' : 's'})`;
      console.log('╔════════════════════════════════════════════════════════════╗');
      console.log(`║ ${streamLabel.padEnd(58)} ║`);
      console.log('╚════════════════════════════════════════════════════════════╝\n');
    }
    
    const streamDuration = streamSeconds * 1000;
    const pollInterval = 500; // Poll every 500ms for smoother updates
    const startTime = Date.now();
    let updateCount = 0;

    // Clear line function for updating display
    const clearLine = () => process.stdout.write('\r\x1b[K');

    while (Date.now() - startTime < streamDuration) {
      try {
        const quotes = await client.getQuote(['MU']);
        if (quotes && quotes.length > 0) {
          const streamQuote = quotes[0];
          const streamData = streamQuote.All || streamQuote;
          
          const streamBid = streamData.bid || 0;
          const streamBidSize = streamData.bidSize || 0;
          const streamAsk = streamData.ask || 0;
          const streamAskSize = streamData.askSize || 0;
          const streamLastTrade = streamData.lastTrade || 0;
          const streamLastSize = streamData.lastSize || 0; // May not be available
          const streamTime = streamData.timeOfLastTrade || Date.now();
          
          updateCount++;
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          
          clearLine();
          process.stdout.write(`[${elapsed}s] Bid: $${streamBid.toFixed(2)} (${streamBidSize.toLocaleString()} shares) | Ask: $${streamAsk.toFixed(2)} (${streamAskSize.toLocaleString()} shares) | Last: $${streamLastTrade.toFixed(2)}${streamLastSize > 0 ? ` (${streamLastSize.toLocaleString()} shares)` : ''}`);
        }
      } catch (error: any) {
        // Silently continue on errors during streaming
      }
      
      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
    
    // Keep the final quote on the line, then newline for what follows
    console.log('');

    process.exit(0);
  } catch (error: any) {
    if (!minimal) {
      console.error('\n╔════════════════════════════════════════════════════════════╗');
      console.error('║              ERROR FETCHING QUOTE DATA                      ║');
      console.error('╚════════════════════════════════════════════════════════════╝\n');
    }
    console.error('Error:', error.message);
    if (error.response) {
      console.error('HTTP Status:', error.response.status);
      console.error('Response data:', JSON.stringify(error.response.data, null, minimal ? 0 : 2));
    }
    process.exit(1);
  }
}

getMicronQuote();
