import { Router } from "express";
import { ETradeClient } from "../services/etrade-client.js";
import type {
  PortfolioPosition,
  PortfolioResponse,
} from "../../shared/types/index.js";

const router = Router();

function getETradeClient(): ETradeClient {
  const isSandbox = process.env.ETRADE_SANDBOX === "true";
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
    { consumerKey, consumerSecret, accessToken, accessTokenSecret },
    isSandbox,
  );
}

async function resolveAccountIdKey(
  client: ETradeClient,
  explicit?: string,
): Promise<string> {
  if (explicit) return explicit;
  const accounts = await client.getAccounts();
  if (!accounts || accounts.length === 0)
    throw new Error("No E*TRADE accounts found");
  const envNickname = process.env.ACCOUNT;
  const activeAccounts = accounts.filter(
    (acc: any) => acc.accountStatus === "ACTIVE",
  );
  const pool = activeAccounts.length > 0 ? activeAccounts : accounts;
  if (envNickname) {
    const match = pool.find((acc: any) =>
      String(acc.accountId).endsWith(String(envNickname)),
    );
    if (match) return match.accountIdKey;
  }
  return pool[0].accountIdKey;
}

function buildSpotPriceMap(quotes: any[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const raw of quotes ?? []) {
    const data = raw.All ?? (raw as any);
    const product = raw.Product ?? raw.product ?? {};
    const symbol =
      (
        raw.symbol ??
        raw.Symbol ??
        data.symbol ??
        data.Symbol ??
        product.symbol ??
        product.Symbol
      )
        ?.toString()
        .toUpperCase() ?? "";
    if (!symbol) continue;
    const last =
      typeof data.lastTrade === "number"
        ? data.lastTrade
        : typeof data.previousClose === "number"
          ? data.previousClose
          : data.bid && data.ask
            ? (data.bid + data.ask) / 2
            : (data.bid ?? data.ask ?? 0);
    if (last) map.set(symbol, last);
  }
  return map;
}

function signedPositionQuantity(position: any): number {
  const rawQuantity =
    position.quantity ??
    position.Quantity ??
    position.positionQuantity ??
    position.PositionQuantity ??
    position.positionQty ??
    position.PositionQty ??
    0;
  const quantity = Number(rawQuantity) || 0;
  if (quantity < 0) return quantity;

  const sideRaw =
    position.positionIndicator ??
    position.PositionIndicator ??
    position.positionType ??
    position.PositionType ??
    position.longShort ??
    position.LongShort ??
    position.positionSide ??
    position.PositionSide;
  const side = String(sideRaw ?? "").toUpperCase();

  return side.includes("SHORT") ? -Math.abs(quantity) : quantity;
}

function normalizeOptionType(value: unknown): "CALL" | "PUT" | undefined {
  const optionType = String(value ?? "").toUpperCase();
  if (optionType === "CALL" || optionType === "PUT") return optionType;
  return undefined;
}

router.get("/", async (req, res) => {
  try {
    const client = getETradeClient();
    const accountIdKey = await resolveAccountIdKey(
      client,
      req.query.accountIdKey as string | undefined,
    );

    const portfolioData = await client.getPortfolio(accountIdKey);

    // E*TRADE response can be camelCase or PascalCase
    const rawPortfolio =
      portfolioData?.AccountPortfolio?.[0] ??
      portfolioData?.AccountPortfolio ??
      portfolioData?.accountPortfolio?.[0] ??
      portfolioData?.accountPortfolio ??
      {};

    const rawPositions = rawPortfolio?.Position ?? rawPortfolio?.position ?? [];
    const list: any[] = Array.isArray(rawPositions)
      ? rawPositions
      : [rawPositions];

    // E*TRADE total market value (from portfolio totals)
    const eTradeTotals = rawPortfolio?.Totals ?? rawPortfolio?.totals ?? {};

    const positions: PortfolioPosition[] = list
      .map((p: any): PortfolioPosition | null => {
        if (!p) return null;
        const product = p.Product ?? p.product ?? {};

        const symbol: string =
          product.symbol ?? p.symbol ?? product.Symbol ?? p.Symbol ?? "";
        if (!symbol) return null;

        const securityTypeRaw =
          product.securityType ??
          p.securityType ??
          product.SecurityType ??
          p.SecurityType;
        const securityType = String(securityTypeRaw ?? "EQUITY").toUpperCase();

        const quantity = signedPositionQuantity(p);

        const underlyingSymbol: string | undefined =
          product.underlyingSymbol ??
          product.UnderlyingSymbol ??
          p.underlyingSymbol ??
          p.UnderlyingSymbol;

        const callPutRaw =
          product.callPut ?? product.CallPut ?? p.callPut ?? p.CallPut;
        const optionType = normalizeOptionType(callPutRaw);

        const strikeRaw =
          product.strikePrice ??
          product.StrikePrice ??
          p.strikePrice ??
          p.StrikePrice;
        const strikePrice = strikeRaw != null ? Number(strikeRaw) : undefined;

        const expiryYear =
          product.expiryYear ??
          product.ExpiryYear ??
          p.expiryYear ??
          p.ExpiryYear;
        const expiryMonth =
          product.expiryMonth ??
          product.ExpiryMonth ??
          p.expiryMonth ??
          p.ExpiryMonth;
        const expiryDay =
          product.expiryDay ?? product.ExpiryDay ?? p.expiryDay ?? p.ExpiryDay;
        let expirationDate: string | undefined;
        if (expiryYear != null && expiryMonth != null && expiryDay != null) {
          const y = Number(expiryYear);
          const m = Number(expiryMonth);
          const d = Number(expiryDay);
          if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
            expirationDate = `${y.toString().padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          }
        }

        const marketValue =
          p.marketValue != null ? Number(p.marketValue) : undefined;
        const pctOfPortfolio =
          p.pctOfPortfolio != null ? Number(p.pctOfPortfolio) : undefined;

        return {
          symbol,
          securityType,
          quantity,
          underlyingSymbol,
          optionType,
          strikePrice,
          expirationDate,
          marketValue,
          pctOfPortfolio,
        } as PortfolioPosition;
      })
      .filter((p): p is PortfolioPosition => !!p);

    // Fetch underlying spot prices so we can compute nominal exposure
    const underlyings = [
      ...new Set(
        positions.map((p) => (p.underlyingSymbol || p.symbol).toUpperCase()),
      ),
    ];
    let spotMap = new Map<string, number>();
    if (underlyings.length > 0) {
      try {
        const quotes = await client.getQuote(underlyings);
        spotMap = buildSpotPriceMap(quotes);
      } catch (e) {
        console.error(
          "Portfolio: failed to fetch underlying quotes:",
          (e as any).message,
        );
      }
    }

    // Enrich each position with underlyingPrice and nominalValue.
    // For options this is signed intrinsic value, not full underlying notional.
    const enriched: PortfolioPosition[] = positions.map((p) => {
      const underlyingKey = (p.underlyingSymbol || p.symbol).toUpperCase();
      const underlyingPrice = spotMap.get(underlyingKey);

      let nominalValue: number | undefined;
      if (underlyingPrice != null && underlyingPrice !== 0) {
        const securityType = String(p.securityType).toUpperCase();
        if (securityType === "OPTN" || securityType === "OPTION") {
          if (p.strikePrice != null && p.optionType) {
            const intrinsicPerShare =
              p.optionType === "CALL"
                ? Math.max(underlyingPrice - p.strikePrice, 0)
                : Math.max(p.strikePrice - underlyingPrice, 0);
            nominalValue =
              Math.sign(p.quantity) *
              Math.abs(p.quantity) *
              100 *
              intrinsicPerShare;
          }
        } else {
          nominalValue = p.quantity * underlyingPrice;
        }
      }

      return { ...p, underlyingPrice, nominalValue };
    });

    const totalMarketValue =
      typeof eTradeTotals.totalMarketValue === "number"
        ? eTradeTotals.totalMarketValue
        : enriched.reduce((sum, p) => sum + (p.marketValue ?? 0), 0);

    const response: PortfolioResponse = {
      accountIdKey,
      positions: enriched,
      totalMarketValue,
    };
    res.json(response);
  } catch (error: any) {
    console.error("Failed to load portfolio:", error.message);
    res
      .status(500)
      .json({ error: error.message || "Failed to load portfolio" });
  }
});

export default router;
