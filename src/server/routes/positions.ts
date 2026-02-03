import { Router } from 'express';
import { ETradeClient } from '../services/etrade-client.js';
import type { Position } from '../../shared/types/index.js';

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

function normalizePositions(portfolioResponse: any): Position[] {
  const rawPositions =
    portfolioResponse?.AccountPortfolio?.[0]?.Position ??
    portfolioResponse?.AccountPortfolio?.Position ??
    portfolioResponse?.accountPortfolio?.[0]?.position ??
    portfolioResponse?.accountPortfolio?.position ??
    [];

  const list = Array.isArray(rawPositions) ? rawPositions : [rawPositions];

  return list
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
}

router.get('/', async (req, res) => {
  try {
    const client = getETradeClient();
    const accountIdKey = await resolveAccountIdKey(
      client,
      req.query.accountIdKey as string | undefined
    );

    const portfolio = await client.getPortfolio(accountIdKey);
    const positions = normalizePositions(portfolio);

    res.json({ accountIdKey, positions });
  } catch (error: any) {
    console.error('Failed to load positions:', error.message);
    res
      .status(500)
      .json({ error: error.message || 'Failed to load positions' });
  }
});

export default router;

