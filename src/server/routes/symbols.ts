import { Router } from 'express';
import { ETradeClient } from '../services/etrade-client.js';

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

router.get('/search', async (req, res) => {
  try {
    const q = (req.query.q as string | undefined)?.trim();

    if (!q || q.length < 2) {
      return res.json({ results: [] });
    }

    const client = getETradeClient();
    const products = await client.lookupProduct(q);

    let results = products
      .map((p: any) => {
        const symbol =
          p.symbol ?? p.Symbol ?? p.productSymbol ?? p.ProductSymbol ?? '';
        if (!symbol) return null;

        const companyName =
          p.companyName ??
          p.description ??
          p.desc ??
          p.CompanyName ??
          p.Description ??
          '';

        const exchange =
          p.exchange ?? p.Exchange ?? p.listedExchange ?? p.ListedExchange ?? '';

        const securityType =
          p.type ??
          p.typeCode ??
          p.securityType ??
          p.Type ??
          p.TypeCode ??
          p.SecurityType ??
          '';

        return {
          symbol,
          companyName,
          exchange,
          securityType,
        };
      })
      .filter((r): r is { symbol: string; companyName: string; exchange: string; securityType: string } => !!r);

    if (results.length === 0 && /^[A-Z0-9.]{1,6}$/.test(q)) {
      try {
        const quotes = await client.getQuote([q]);
        if (quotes?.length && quotes[0]?.symbol) {
          results = [
            {
              symbol: quotes[0].symbol,
              companyName: q,
              exchange: '',
              securityType: 'EQUITY',
            },
          ];
        }
      } catch {
        // leave results empty
      }
    }

    res.json({ results });
  } catch (error: any) {
    res
      .status(500)
      .json({ error: error.message || 'Failed to look up symbols' });
  }
});

export default router;

