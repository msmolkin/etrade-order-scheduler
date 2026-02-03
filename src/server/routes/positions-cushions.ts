import { Router } from 'express';
import { ETradeClient } from '../services/etrade-client.js';
import type {
  Position,
  PositionCushion,
  OptionLegSummary,
  UnderlyingQuoteSummary,
  OptionsChain,
  ETradeQuote,
} from '../../shared/types/index.js';

const router = Router();

function getETradeClient(): ETradeClient {
  const isSandbox = process.env.ETRADE_SANDBOX === 'true';

  const consumerKey = isSandbox
    ? process.env.ETRADE_SANDBOX_KEY!
    : process.env.ETRADE_CONSUMER_KEY!;
  const consumerSecret = isSandbox
    ? process.env.ETRADE_SANDBOX_SECRET!
    : process.env.ETRADE_CONSUMER_SECRET!;
  const accessToken = isSandbox
    ? process.env.ETRADE_SANDBOX_ACCESS_TOKEN
    : process.env.ETRADE_ACCESS_TOKEN;
  const accessTokenSecret = isSandbox
    ? process.env.ETRADE_SANDBOX_ACCESS_TOKEN_SECRET
    : process.env.ETRADE_ACCESS_TOKEN_SECRET;

  return new ETradeClient(
    {
      consumerKey,
      consumerSecret,
      accessToken,
      accessTokenSecret,
    },
    isSandbox
  );
}

async function resolveAccountIdKey(
  client: ETradeClient,
  explicit?: string
): Promise<string> {
  if (explicit) return explicit;

  const accounts = await client.getAccounts();
  if (!accounts || accounts.length === 0) {
    throw new Error('No E*TRADE accounts found');
  }

  const envNickname = process.env.ACCOUNT;
  const activeAccounts = accounts.filter((acc: any) => acc.accountStatus === 'ACTIVE');
  const pool = activeAccounts.length > 0 ? activeAccounts : accounts;

  if (envNickname) {
    const match = pool.find((acc: any) =>
      String(acc.accountId).endsWith(String(envNickname))
    );
    if (match) {
      return match.accountIdKey;
    }
  }

  return pool[0].accountIdKey;
}

function groupByUnderlying(positions: Position[]): Map<string, Position[]> {
  const map = new Map<string, Position[]>();
  for (const p of positions) {
    const underlying = p.underlyingSymbol || p.symbol;
    const key = underlying.toUpperCase();
    const arr = map.get(key) ?? [];
    arr.push(p);
    map.set(key, arr);
  }
  return map;
}

function findHighestOiLegs(chain: OptionsChain): {
  call?: OptionLegSummary;
  put?: OptionLegSummary;
} {
  let bestCall: OptionLegSummary | undefined;
  let bestPut: OptionLegSummary | undefined;

  for (const c of chain.calls ?? []) {
    if (!bestCall || c.openInterest > bestCall.openInterest) {
      bestCall = {
        symbol: c.symbol,
        optionType: c.optionType,
        strikePrice: c.strikePrice,
        expirationDate: c.expirationDate,
        openInterest: c.openInterest,
        bid: c.bid,
        ask: c.ask,
      };
    }
  }

  for (const p of chain.puts ?? []) {
    if (!bestPut || p.openInterest > bestPut.openInterest) {
      bestPut = {
        symbol: p.symbol,
        optionType: p.optionType,
        strikePrice: p.strikePrice,
        expirationDate: p.expirationDate,
        openInterest: p.openInterest,
        bid: p.bid,
        ask: p.ask,
      };
    }
  }

  return { call: bestCall, put: bestPut };
}

function buildUnderlyingQuotesMap(quotes: ETradeQuote[]): Map<string, UnderlyingQuoteSummary> {
  const map = new Map<string, UnderlyingQuoteSummary>();
  for (const q of quotes ?? []) {
    const symbol = q.symbol?.toUpperCase?.() ?? '';
    if (!symbol) continue;
    map.set(symbol, {
      symbol,
      bid: q.bid,
      ask: q.ask,
      last: q.last,
    });
  }
  return map;
}

router.get('/', async (req, res) => {
  try {
    const client = getETradeClient();
    const accountIdKey = await resolveAccountIdKey(
      client,
      req.query.accountIdKey as string | undefined
    );

    // 1) Fetch portfolio and normalize to Position[]
    const portfolio = await client.getPortfolio(accountIdKey);
    const rawPositions =
      portfolio?.AccountPortfolio?.[0]?.Position ??
      portfolio?.AccountPortfolio?.Position ??
      portfolio?.accountPortfolio?.[0]?.position ??
      portfolio?.accountPortfolio?.position ??
      [];
    const list = Array.isArray(rawPositions) ? rawPositions : [rawPositions];

    const positions: Position[] = list
      .map((p: any): Position | null => {
        if (!p) return null;
        const product = p.Product ?? p.product ?? {};
        const symbol: string =
          product.symbol ?? p.symbol ?? product.Symbol ?? p.Symbol ?? '';
        if (!symbol) return null;

        const securityTypeRaw =
          product.securityType ?? p.securityType ?? product.SecurityType ?? p.SecurityType;
        const securityType = String(securityTypeRaw ?? 'EQUITY').toUpperCase();

        const quantityRaw =
          p.quantity ?? p.Quantity ?? p.positionQuantity ?? p.positionQty ?? 0;
        const quantity = Number(quantityRaw) || 0;

        const underlyingSymbol: string | undefined =
          product.underlyingSymbol ??
          product.UnderlyingSymbol ??
          p.underlyingSymbol ??
          p.UnderlyingSymbol;

        const callPutRaw =
          product.callPut ?? product.CallPut ?? p.callPut ?? p.CallPut;
        const optionType =
          callPutRaw === 'CALL' || callPutRaw === 'PUT' ? callPutRaw : undefined;

        const strikeRaw =
          product.strikePrice ??
          product.StrikePrice ??
          p.strikePrice ??
          p.StrikePrice;
        const strikePrice =
          strikeRaw !== undefined && strikeRaw !== null ? Number(strikeRaw) : undefined;

        const expiryYear =
          product.expiryYear ?? product.ExpiryYear ?? p.expiryYear ?? p.ExpiryYear;
        const expiryMonth =
          product.expiryMonth ??
          product.ExpiryMonth ??
          p.expiryMonth ??
          p.ExpiryMonth;
        const expiryDay =
          product.expiryDay ?? product.ExpiryDay ?? p.expiryDay ?? p.ExpiryDay;

        let expirationDate: string | undefined;
        if (
          expiryYear != null &&
          expiryMonth != null &&
          expiryDay != null &&
          !isNaN(Number(expiryYear)) &&
          !isNaN(Number(expiryMonth)) &&
          !isNaN(Number(expiryDay))
        ) {
          const y = Number(expiryYear);
          const m = Number(expiryMonth);
          const d = Number(expiryDay);
          expirationDate = `${y.toString().padStart(4, '0')}-${String(m).padStart(
            2,
            '0'
          )}-${String(d).padStart(2, '0')}`;
        }

        return {
          symbol,
          securityType,
          quantity,
          underlyingSymbol,
          optionType,
          strikePrice,
          expirationDate,
        } as Position;
      })
      .filter((p): p is Position => !!p);

    if (!positions.length) {
      return res.json({ accountIdKey, cushions: [] as PositionCushion[] });
    }

    // 2) Group positions by underlying symbol
    const grouped = groupByUnderlying(positions);
    const underlyings = Array.from(grouped.keys());

    // 3) For each underlying, fetch options chain and compute highest OI call/put
    const chainResults = await Promise.all(
      underlyings.map(async (sym) => {
        try {
          const chain = await client.getOptionsChain(sym);
          const { call, put } = findHighestOiLegs(chain);
          return { symbol: sym, call, put };
        } catch (e) {
          console.error(`Failed to load options chain for ${sym}:`, (e as any).message);
          return { symbol: sym, call: undefined as OptionLegSummary | undefined, put: undefined as OptionLegSummary | undefined };
        }
      })
    );

    const highestMap = new Map<
      string,
      { call?: OptionLegSummary; put?: OptionLegSummary }
    >();
    for (const r of chainResults) {
      highestMap.set(r.symbol.toUpperCase(), {
        call: r.call,
        put: r.put,
      });
    }

    // 4) Fetch quotes for all underlyings (for bid/ask/last)
    let quoteMap = new Map<string, UnderlyingQuoteSummary>();
    try {
      const quotes = await client.getQuote(underlyings);
      quoteMap = buildUnderlyingQuotesMap(quotes);
    } catch (e) {
      console.error('Failed to load quotes for underlyings:', (e as any).message);
    }

    // 5) Build PositionCushion objects per position
    const cushions: PositionCushion[] = positions.map((p) => {
      const underlying = (p.underlyingSymbol || p.symbol).toUpperCase();
      const hi = highestMap.get(underlying) ?? {};
      const quote = quoteMap.get(underlying) ?? null;

      return {
        position: p,
        highestOiCall: hi.call,
        highestOiPut: hi.put,
        underlyingQuote: quote,
      };
    });

    res.json({ accountIdKey, cushions });
  } catch (error: any) {
    console.error('Failed to load position cushions:', error.message);
    res
      .status(500)
      .json({ error: error.message || 'Failed to load position cushions' });
  }
});

export default router;

