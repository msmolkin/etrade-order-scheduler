import axios from 'axios';
import dotenv from 'dotenv';
import { ETradeClient } from '../server/services/etrade-client.js';
import type { ETradeCredentials, ETradeQuote, ETradeQuoteAll } from '../shared/types/index.js';

dotenv.config({ quiet: true });

type SourceStatus = 'live' | 'delayed' | 'end-of-day';

type LatestPriceResult = {
  price: number;
  source: string;
  status: SourceStatus;
  asOfLabel: string;
  note?: string;
};

type HistoricalBar = {
  timestamp: number;
  close: number;
};

type YahooChartMeta = {
  currency?: string;
  symbol?: string;
  regularMarketPrice?: number;
  regularMarketTime?: number;
  currentTradingPeriod?: {
    regular?: {
      start?: number;
      end?: number;
      timezone?: string;
      gmtoffset?: number;
    };
  };
  exchangeTimezoneName?: string;
  gmtoffset?: number;
};

type YahooChartResult = {
  meta?: YahooChartMeta;
  timestamp?: number[];
  indicators?: {
    quote?: Array<{
      close?: Array<number | null>;
    }>;
  };
};

type YahooHistoryResult = {
  bars: HistoricalBar[];
  meta: YahooChartMeta;
  source: string;
  status: SourceStatus;
  note?: string;
};

type ParsedArgs = {
  symbol: string;
  historySymbol: string;
};

const DAILY_SMA_PERIODS = [200, 150, 100, 50, 20, 14, 13, 10, 9, 5];
const WEEKLY_SMA_PERIODS = [14, 10];
const DAILY_EMA_PERIOD = 10;
const INTRADAY_EMA_PERIOD = 9;

function parseArgs(argv: string[]): ParsedArgs {
  const nonFlags: string[] = [];
  let historySymbol: string | undefined;

  for (const arg of argv) {
    if (arg.startsWith('--history-symbol=')) {
      historySymbol = arg.slice('--history-symbol='.length).trim();
      continue;
    }
    if (arg.startsWith('--yahoo-symbol=')) {
      historySymbol = arg.slice('--yahoo-symbol='.length).trim();
      continue;
    }
    if (!arg.startsWith('--')) {
      nonFlags.push(arg);
    }
  }

  const symbol = (nonFlags[0] || 'MU').trim().toUpperCase();
  const resolvedHistorySymbol = (historySymbol || symbol).trim();

  return {
    symbol,
    historySymbol: resolvedHistorySymbol,
  };
}

function getETradeCredentials(): ETradeCredentials | null {
  const isSandbox = process.env.ETRADE_SANDBOX === 'true';
  const credentials: ETradeCredentials = isSandbox
    ? {
        consumerKey: process.env.ETRADE_SANDBOX_KEY || '',
        consumerSecret: process.env.ETRADE_SANDBOX_SECRET || '',
        accessToken: process.env.ETRADE_SANDBOX_ACCESS_TOKEN,
        accessTokenSecret: process.env.ETRADE_SANDBOX_ACCESS_TOKEN_SECRET,
      }
    : {
        consumerKey: process.env.ETRADE_CONSUMER_KEY || '',
        consumerSecret: process.env.ETRADE_CONSUMER_SECRET || '',
        accessToken: process.env.ETRADE_ACCESS_TOKEN,
        accessTokenSecret: process.env.ETRADE_ACCESS_TOKEN_SECRET,
      };

  if (!credentials.consumerKey || !credentials.consumerSecret) {
    return null;
  }

  return credentials;
}

function parseETradeQuote(quote: ETradeQuote | undefined): {
  price: number | null;
  quoteStatus?: string;
  dateTime?: string;
} {
  if (!quote) {
    return { price: null };
  }

  const data = (quote.All ?? quote) as ETradeQuoteAll;
  const rawPrice = data.lastTrade ?? data.previousClose;
  const price = typeof rawPrice === 'number' && Number.isFinite(rawPrice) ? rawPrice : null;

  return {
    price,
    quoteStatus: quote.quoteStatus,
    dateTime: quote.dateTime,
  };
}

function normalizeErrorMessage(error: unknown): string {
  const err = error as any;
  const responseData = err?.response?.data;

  if (typeof responseData === 'string' && responseData.trim()) {
    return responseData.replace(/\s+/g, ' ').trim();
  }
  if (responseData?.message) {
    return String(responseData.message);
  }
  if (err?.message) {
    return String(err.message);
  }
  return String(error);
}

function mapETradeQuoteStatus(quoteStatus?: string): SourceStatus {
  const normalized = String(quoteStatus || '').toUpperCase();
  if (normalized === 'REALTIME') {
    return 'live';
  }
  if (normalized === 'DELAYED') {
    return 'delayed';
  }
  return 'delayed';
}

function isRegularSessionOpen(meta: YahooChartMeta | undefined): boolean {
  const regular = meta?.currentTradingPeriod?.regular;
  if (!regular?.start || !regular?.end) {
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  return now >= regular.start && now <= regular.end;
}

function classifyYahooStatus(interval: '5m' | '1d' | '1wk', meta: YahooChartMeta): SourceStatus {
  if (interval === '5m') {
    return 'delayed';
  }
  if (isRegularSessionOpen(meta)) {
    return 'delayed';
  }
  return 'end-of-day';
}

function formatTimestamp(epochSeconds: number | undefined, timeZone?: string): string {
  if (!epochSeconds || !Number.isFinite(epochSeconds)) {
    return 'n/a';
  }

  return new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).format(new Date(epochSeconds * 1000));
}

function formatPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return 'n/a';
  }
  const abs = Math.abs(value);
  const digits = abs >= 1 ? 2 : 4;
  return `$${value.toFixed(digits)}`;
}

function computeSMA(values: number[], period: number): number | null {
  if (values.length < period) {
    return null;
  }
  const slice = values.slice(-period);
  const sum = slice.reduce((acc, value) => acc + value, 0);
  return sum / period;
}

function computeEMA(values: number[], period: number): number | null {
  if (values.length < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((acc, value) => acc + value, 0) / period;

  for (let index = period; index < values.length; index += 1) {
    ema = (values[index]! - ema) * multiplier + ema;
  }

  return ema;
}

function computeEMAValues(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < period) {
    return result;
  }

  const multiplier = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((acc, value) => acc + value, 0) / period;
  result[period - 1] = ema;

  for (let index = period; index < values.length; index += 1) {
    ema = (values[index]! - ema) * multiplier + ema;
    result[index] = ema;
  }

  return result;
}

function buildDailyEmaCutSignal(latestPrice: number, closes: number[], period: number): {
  ema: number | null;
  signal: string;
} {
  const emaValues = computeEMAValues(closes, period);
  const currentEma = emaValues[emaValues.length - 1] ?? null;
  const previousEma = emaValues.length >= 2 ? emaValues[emaValues.length - 2] ?? null : null;
  const previousClose = closes.length >= 2 ? closes[closes.length - 2] ?? null : null;

  if (currentEma == null) {
    return {
      ema: null,
      signal: 'unavailable',
    };
  }

  if (previousClose != null && previousEma != null) {
    if (previousClose <= previousEma && latestPrice > currentEma) {
      return { ema: currentEma, signal: 'crossing up' };
    }
    if (previousClose >= previousEma && latestPrice < currentEma) {
      return { ema: currentEma, signal: 'crossing down' };
    }
  }

  if (latestPrice > currentEma) {
    return { ema: currentEma, signal: 'above' };
  }
  if (latestPrice < currentEma) {
    return { ema: currentEma, signal: 'below' };
  }
  return { ema: currentEma, signal: 'at' };
}

async function tryFetchETradeLatestPrice(symbol: string): Promise<LatestPriceResult | null> {
  const credentials = getETradeCredentials();
  if (!credentials?.accessToken || !credentials.accessTokenSecret) {
    return null;
  }

  const isSandbox = process.env.ETRADE_SANDBOX === 'true';
  const client = new ETradeClient(credentials, isSandbox);
  const quoteResponse = await client.getQuote([symbol]);
  const parsed = parseETradeQuote(quoteResponse?.[0]);

  if (parsed.price == null) {
    throw new Error(`No usable E*TRADE quote returned for ${symbol}`);
  }

  return {
    price: parsed.price,
    source: `E*TRADE Market Quote API (${isSandbox ? 'sandbox' : 'production'}) GET /v1/market/quote/${symbol}`,
    status: mapETradeQuoteStatus(parsed.quoteStatus),
    asOfLabel: parsed.dateTime || 'n/a',
  };
}

async function fetchYahooHistory(symbol: string, interval: '5m' | '1d' | '1wk', range: string): Promise<YahooHistoryResult> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  const response = await axios.get(url, {
    params: {
      interval,
      range,
      includePrePost: false,
      events: 'div,splits',
    },
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json',
    },
    timeout: 30000,
  });

  const result = response.data?.chart?.result?.[0] as YahooChartResult | undefined;
  const error = response.data?.chart?.error;
  if (!result || error) {
    throw new Error(error?.description || `Yahoo Finance returned no chart data for ${symbol}`);
  }

  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const closes = Array.isArray(result.indicators?.quote?.[0]?.close)
    ? result.indicators?.quote?.[0]?.close ?? []
    : [];

  const bars: HistoricalBar[] = [];
  const count = Math.min(timestamps.length, closes.length);
  for (let index = 0; index < count; index += 1) {
    const timestamp = timestamps[index];
    const close = closes[index];
    if (
      typeof timestamp === 'number' &&
      Number.isFinite(timestamp) &&
      typeof close === 'number' &&
      Number.isFinite(close)
    ) {
      bars.push({ timestamp, close });
    }
  }

  if (bars.length === 0) {
    throw new Error(`Yahoo Finance returned no usable ${interval} closes for ${symbol}`);
  }

  const meta = result.meta || {};
  return {
    bars,
    meta,
    source: `Yahoo Finance chart API (${symbol}, interval=${interval}, range=${range})`,
    status: classifyYahooStatus(interval, meta),
    note:
      interval === '5m'
        ? 'True live 5-minute bars were not available from the configured E*TRADE integration, so this uses Yahoo Finance 5-minute intraday bars as the best available fallback.'
        : undefined,
  };
}

function buildReport(args: {
  symbol: string;
  historySymbol: string;
  latest: LatestPriceResult;
  latestFallbackReason?: string;
  dailyHistory: YahooHistoryResult;
  weeklyHistory: YahooHistoryResult;
  intradayHistory: YahooHistoryResult;
}): string {
  const {
    symbol,
    historySymbol,
    latest,
    latestFallbackReason,
    dailyHistory,
    weeklyHistory,
    intradayHistory,
  } = args;

  const dailyCloses = dailyHistory.bars.map((bar) => bar.close);
  const weeklyCloses = weeklyHistory.bars.map((bar) => bar.close);
  const intradayCloses = intradayHistory.bars.map((bar) => bar.close);

  const dailySmas = DAILY_SMA_PERIODS.map((period) => ({
    period,
    value: computeSMA(dailyCloses, period),
  }));
  const weeklySmas = WEEKLY_SMA_PERIODS.map((period) => ({
    period,
    value: computeSMA(weeklyCloses, period),
  }));
  const intradayEma = computeEMA(intradayCloses, INTRADAY_EMA_PERIOD);
  const dailyCut = buildDailyEmaCutSignal(latest.price, dailyCloses, DAILY_EMA_PERIOD);

  const latestDailyBar = dailyHistory.bars[dailyHistory.bars.length - 1];
  const latestWeeklyBar = weeklyHistory.bars[weeklyHistory.bars.length - 1];
  const latestIntradayBar = intradayHistory.bars[intradayHistory.bars.length - 1];
  const timeZone = dailyHistory.meta.exchangeTimezoneName || intradayHistory.meta.exchangeTimezoneName || 'America/New_York';

  const lines: string[] = [];
  lines.push(`Market analysis for ${symbol}`);
  if (historySymbol !== symbol) {
    lines.push(`History symbol override: ${historySymbol}`);
  }
  lines.push('');
  lines.push('Data sources');
  lines.push(`- Latest price: ${latest.source} — ${latest.status}`);
  lines.push(`  As of: ${latest.asOfLabel}`);
  if (latestFallbackReason) {
    lines.push(`  Fallback note: ${latestFallbackReason}`);
  }
  lines.push(`- Daily SMAs + daily 10 EMA cut: ${dailyHistory.source} — ${dailyHistory.status}`);
  lines.push(`  Latest daily bar: ${formatTimestamp(latestDailyBar?.timestamp, timeZone)}`);
  lines.push(`- Weekly SMAs: ${weeklyHistory.source} — ${weeklyHistory.status}`);
  lines.push(`  Latest weekly bar: ${formatTimestamp(latestWeeklyBar?.timestamp, timeZone)}`);
  lines.push(`- 5-minute 9 EMA: ${intradayHistory.source} — ${intradayHistory.status}`);
  lines.push(`  Latest 5-minute bar: ${formatTimestamp(latestIntradayBar?.timestamp, timeZone)}`);
  if (intradayHistory.note) {
    lines.push(`  Note: ${intradayHistory.note}`);
  }
  lines.push('');
  lines.push('Latest price');
  lines.push(`- Price: ${formatPrice(latest.price)}`);
  lines.push('');
  lines.push('Daily simple moving averages');
  for (const item of dailySmas) {
    lines.push(`- SMA ${item.period}: ${formatPrice(item.value)}`);
  }
  lines.push('');
  lines.push('Weekly simple moving averages');
  for (const item of weeklySmas) {
    lines.push(`- SMA ${item.period}: ${formatPrice(item.value)}`);
  }
  lines.push('');
  lines.push('Daily 10-day EMA cut signal');
  lines.push(`- 10-day EMA: ${formatPrice(dailyCut.ema)}`);
  lines.push(`- Signal: ${dailyCut.signal}`);
  lines.push('');
  lines.push('5-minute 9 EMA');
  lines.push(`- 9 EMA: ${formatPrice(intradayEma)}`);
  if (intradayEma == null) {
    lines.push('- Price vs 9 EMA: unavailable');
  } else if (latest.price > intradayEma) {
    lines.push('- Price vs 9 EMA: above');
  } else if (latest.price < intradayEma) {
    lines.push('- Price vs 9 EMA: below');
  } else {
    lines.push('- Price vs 9 EMA: at');
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  const { symbol, historySymbol } = parseArgs(process.argv.slice(2));

  let latest: LatestPriceResult | null = null;
  let latestFallbackReason: string | undefined;

  try {
    latest = await tryFetchETradeLatestPrice(symbol);
  } catch (error) {
    latestFallbackReason = `E*TRADE latest quote unavailable: ${normalizeErrorMessage(error)}`;
  }

  const [dailyHistory, weeklyHistory, intradayHistory] = await Promise.all([
    fetchYahooHistory(historySymbol, '1d', '2y'),
    fetchYahooHistory(historySymbol, '1wk', '5y'),
    fetchYahooHistory(historySymbol, '5m', '5d'),
  ]);

  if (!latest) {
    const fallbackPrice =
      (typeof intradayHistory.meta.regularMarketPrice === 'number' && Number.isFinite(intradayHistory.meta.regularMarketPrice)
        ? intradayHistory.meta.regularMarketPrice
        : intradayHistory.bars[intradayHistory.bars.length - 1]?.close) ?? null;

    if (fallbackPrice == null) {
      throw new Error(`No usable latest price was available for ${symbol}`);
    }

    latest = {
      price: fallbackPrice,
      source: `Yahoo Finance chart API latest market price (${historySymbol})`,
      status: 'delayed',
      asOfLabel: formatTimestamp(
        intradayHistory.meta.regularMarketTime || intradayHistory.bars[intradayHistory.bars.length - 1]?.timestamp,
        intradayHistory.meta.exchangeTimezoneName
      ),
      note: latestFallbackReason,
    };
  }

  console.log(
    buildReport({
      symbol,
      historySymbol,
      latest,
      latestFallbackReason,
      dailyHistory,
      weeklyHistory,
      intradayHistory,
    })
  );
}

main().catch((error) => {
  console.error(`Analysis failed: ${normalizeErrorMessage(error)}`);
  process.exit(1);
});
