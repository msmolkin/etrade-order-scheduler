import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { ETradeClient } from "../server/services/etrade-client.js";
import type { ETradeCredentials } from "../shared/types/index.js";

dotenv.config({ quiet: true });

type MarginRequirement = {
  symbol: string;
  longPct: number | null;
  shortPct: number | null;
  nakedOptionPct: number | null;
  perShareLong: number | null;
  perShareShort: number | null;
};

type Row = {
  symbol: string;
  underlying: string;
  securityType: string;
  quantity: number;
  marketValue: number;
  price: number | null;
  marginRequirement: number;
  marginLabel: string;
  reason: string;
};

const OUT_DIR = path.join(process.cwd(), "tmp", "portfolio-margin-analysis");
const BATCH_SIZE = 10;

function clientFromEnv(): ETradeClient {
  const isSandbox = process.env.ETRADE_SANDBOX === "true";
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
  return new ETradeClient(credentials, isSandbox);
}

async function resolveAccount(client: ETradeClient) {
  const accounts = await client.getAccounts();
  const active = accounts.filter((a: any) => a.accountStatus === "ACTIVE");
  const pool = active.length ? active : accounts;
  const suffix = process.env.ACCOUNT ?? "";
  const match =
    pool.find((a: any) => String(a.accountId).endsWith(String(suffix))) ??
    pool[0];
  if (!match) throw new Error("No E*TRADE account found");
  return match;
}

function listPositions(portfolio: any): any[] {
  const accountPortfolio =
    portfolio?.AccountPortfolio?.[0] ??
    portfolio?.AccountPortfolio ??
    portfolio?.accountPortfolio?.[0] ??
    portfolio?.accountPortfolio ??
    {};
  const positions =
    accountPortfolio?.Position ?? accountPortfolio?.position ?? [];
  return (Array.isArray(positions) ? positions : [positions]).filter(Boolean);
}

function productOf(position: any): any {
  return position.Product ?? position.product ?? {};
}

function symbolOf(position: any): string {
  const p = productOf(position);
  return String(
    p.symbol ?? p.Symbol ?? position.symbol ?? position.Symbol ?? "",
  ).toUpperCase();
}

function securityTypeOf(position: any): string {
  const p = productOf(position);
  return String(
    p.securityType ??
      p.SecurityType ??
      position.securityType ??
      position.SecurityType ??
      "EQ",
  ).toUpperCase();
}

function underlyingOf(position: any): string {
  const p = productOf(position);
  return String(
    p.underlyingSymbol ??
      p.UnderlyingSymbol ??
      position.underlyingSymbol ??
      position.UnderlyingSymbol ??
      symbolOf(position),
  ).toUpperCase();
}

function quantityOf(position: any): number {
  return (
    Number(
      position.quantity ??
        position.Quantity ??
        position.positionQuantity ??
        position.positionQty ??
        0,
    ) || 0
  );
}

function marketValueOf(position: any): number {
  return Number(position.marketValue ?? position.MarketValue ?? 0) || 0;
}

function priceFromQuote(raw: any): number | null {
  const data = raw?.All ?? raw;
  const price =
    Number(data?.lastTrade) ||
    Number(data?.lastPrice) ||
    Number(data?.previousClose) ||
    (Number(data?.bid) && Number(data?.ask)
      ? (Number(data.bid) + Number(data.ask)) / 2
      : 0) ||
    Number(data?.bid) ||
    Number(data?.ask) ||
    0;
  return Number.isFinite(price) && price > 0 ? price : null;
}

async function fetchPrices(
  client: ETradeClient,
  symbols: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for (let i = 0; i < symbols.length; i += 25) {
    const batch = symbols.slice(i, i + 25);
    const quotes = await client.getQuote(batch);
    for (const q of quotes as any[]) {
      const data = q.All ?? q;
      const symbol = String(q.symbol ?? data.symbol ?? "").toUpperCase();
      const price = priceFromQuote(q);
      if (symbol && price) map.set(symbol, price);
    }
  }
  return map;
}

function parseReq(
  reqType: number,
  reqVal: string,
): { pct: number | null; perShare: number | null } {
  const value = Number.parseFloat(reqVal);
  if (reqType === 1 && Number.isFinite(value))
    return { pct: value * 100, perShare: null };
  if (reqType === 3 && Number.isFinite(value))
    return { pct: null, perShare: value };
  return { pct: null, perShare: null };
}

async function fetchMarginRequirements(
  symbols: string[],
): Promise<Map<string, MarginRequirement>> {
  const out = new Map<string, MarginRequirement>();
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const res = await fetch(
      "https://us.etrade.com/app/margin-tools/requirements-search-help.json",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: { acctId: "", symbols: batch } }),
      },
    );
    if (!res.ok) throw new Error(`E*TRADE margin tools HTTP ${res.status}`);
    const json = (await res.json()) as any;
    const products = json?.data?.requirementlookup?.prdList ?? [];
    for (const prd of products) {
      if (prd?.error?.code === 1138) continue;
      const long = parseReq(prd.longReqType, prd.longReq);
      const short = parseReq(prd.shortReqType, prd.shortReq);
      const naked = Number.parseFloat(prd.nakedOptionPct);
      out.set(String(prd.symbol).toUpperCase(), {
        symbol: String(prd.symbol).toUpperCase(),
        longPct: long.pct,
        shortPct: short.pct,
        nakedOptionPct: Number.isFinite(naked) ? naked * 100 : null,
        perShareLong: long.perShare,
        perShareShort: short.perShare,
      });
    }
  }
  return out;
}

function estimateMargin(
  position: any,
  req: MarginRequirement | undefined,
  price: number | null,
): Row {
  const securityType = securityTypeOf(position);
  const symbol = symbolOf(position);
  const underlying = underlyingOf(position);
  const quantity = quantityOf(position);
  const marketValue = marketValueOf(position);
  const absQty = Math.abs(quantity);
  const notional =
    securityType === "OPTN" || securityType === "OPTION"
      ? absQty * 100 * (price ?? 0)
      : Math.abs(marketValue || absQty * (price ?? 0));

  if (!req) {
    return {
      symbol,
      underlying,
      securityType,
      quantity,
      marketValue,
      price,
      marginRequirement: 0,
      marginLabel: "missing",
      reason: "No margin-tools result",
    };
  }

  const isShort = quantity < 0 || marketValue < 0;
  if (securityType === "OPTN" || securityType === "OPTION") {
    if (!isShort) {
      return {
        symbol,
        underlying,
        securityType,
        quantity,
        marketValue,
        price,
        marginRequirement: Math.abs(marketValue),
        marginLabel: "long option premium",
        reason: "Long options mainly consume cash/premium, not position margin",
      };
    }
    const pct = req.nakedOptionPct ?? req.shortPct;
    const margin = pct != null ? (notional * pct) / 100 : Math.abs(marketValue);
    return {
      symbol,
      underlying,
      securityType,
      quantity,
      marketValue,
      price,
      marginRequirement: margin,
      marginLabel:
        pct != null
          ? `${Math.round(pct)}% naked/short option`
          : "option fallback",
      reason:
        "Short options are ranked by naked-option requirement on underlying notional",
    };
  }

  const pct = isShort ? req.shortPct : req.longPct;
  const perShare = isShort ? req.perShareShort : req.perShareLong;
  const margin =
    pct != null
      ? (notional * pct) / 100
      : perShare != null
        ? absQty * perShare
        : 0;
  return {
    symbol,
    underlying,
    securityType,
    quantity,
    marketValue,
    price,
    marginRequirement: margin,
    marginLabel:
      pct != null
        ? `${Math.round(pct)}% ${isShort ? "short" : "long"}`
        : perShare != null
          ? `$${perShare}/sh`
          : "N/A",
    reason: isShort
      ? "Closing short shares reduces short margin requirement"
      : "Selling long shares reduces long maintenance requirement",
  };
}

function money(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const client = clientFromEnv();
  const account = await resolveAccount(client);
  const portfolio = await client.getPortfolio(account.accountIdKey);
  const positions = listPositions(portfolio);
  const symbols = [
    ...new Set(positions.map(underlyingOf).filter(Boolean)),
  ].sort();

  const [prices, marginReqs] = await Promise.all([
    fetchPrices(client, symbols),
    fetchMarginRequirements(symbols),
  ]);

  const rows = positions
    .map((p) =>
      estimateMargin(
        p,
        marginReqs.get(underlyingOf(p)),
        prices.get(underlyingOf(p)) ?? null,
      ),
    )
    .sort((a, b) => b.marginRequirement - a.marginRequirement);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rawPath = path.join(OUT_DIR, `portfolio-7280-${stamp}.json`);
  const reportPath = path.join(OUT_DIR, `margin-impact-7280-${stamp}.json`);
  fs.writeFileSync(rawPath, JSON.stringify({ account, portfolio }, null, 2));
  fs.writeFileSync(
    reportPath,
    JSON.stringify({ account, asOf: new Date().toISOString(), rows }, null, 2),
  );

  console.log(`Raw portfolio: ${rawPath}`);
  console.log(`Report: ${reportPath}`);
  console.log(
    `Positions: ${positions.length}; underlyings checked: ${symbols.length}`,
  );
  console.log("");
  console.log("Rank | Symbol | Qty | MV | Margin impact | Rule | Reason");
  rows.slice(0, 30).forEach((r, i) => {
    console.log(
      [
        String(i + 1).padStart(2),
        r.symbol.padEnd(8),
        String(r.quantity).padStart(8),
        money(r.marketValue).padStart(12),
        money(r.marginRequirement).padStart(14),
        r.marginLabel.padEnd(18),
        r.reason,
      ].join(" | "),
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
