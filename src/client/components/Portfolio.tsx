import React, { useState } from "react";
import { usePortfolio } from "../hooks/usePortfolio";
import type { PortfolioPosition } from "../utils/api";
import type { OrderFormDraft } from "./OrderForm";

function fmt$(v: number | undefined, opts?: { sign?: boolean }): string {
  if (v == null || !Number.isFinite(v)) return "\u2014";
  const abs = Math.abs(v);
  let s: string;
  if (abs >= 1_000_000) {
    s = `$${(abs / 1_000_000).toFixed(2)}M`;
  } else if (abs >= 1_000) {
    s = `$${(abs / 1_000).toFixed(1)}k`;
  } else {
    s = `$${abs.toFixed(2)}`;
  }
  if (v < 0) s = `-${s}`;
  else if (opts?.sign && v > 0) s = `+${s}`;
  return s;
}

function fmtPct(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return "\u2014";
  return `${v.toFixed(2)}%`;
}

function nominalColor(v: number | undefined): string {
  if (v == null) return "";
  if (v > 0) return "color: #4ade80";
  if (v < 0) return "color: #f87171";
  return "";
}

function isOption(p: PortfolioPosition): boolean {
  return p.securityType === "OPTN" || p.securityType === "OPTION";
}

function underlying(p: PortfolioPosition): string {
  if (isOption(p)) return (p.underlyingSymbol || p.symbol).toUpperCase();
  return p.symbol.toUpperCase();
}

function optionLabel(p: PortfolioPosition): string {
  const type = p.optionType ?? "?";
  const strike = p.strikePrice != null ? `$${p.strikePrice}` : "";
  const expiry = p.expirationDate ?? "";
  return `${type} ${strike} ${expiry}`.trim();
}

interface SymbolGroup {
  symbol: string;
  equity: PortfolioPosition | null;
  options: PortfolioPosition[];
  totalMarketValue: number;
  totalPct: number;
  netNominal: number;
  underlyingPrice: number | null;
}

function buildGroups(positions: PortfolioPosition[]): SymbolGroup[] {
  const map = new Map<string, SymbolGroup>();
  for (const p of positions) {
    const sym = underlying(p);
    let g = map.get(sym);
    if (!g) {
      g = {
        symbol: sym,
        equity: null,
        options: [],
        totalMarketValue: 0,
        totalPct: 0,
        netNominal: 0,
        underlyingPrice: null,
      };
      map.set(sym, g);
    }
    if (isOption(p)) g.options.push(p);
    else g.equity = p;
    g.totalMarketValue += p.marketValue ?? 0;
    g.totalPct += p.pctOfPortfolio ?? 0;
    g.netNominal += p.nominalValue ?? 0;
    if (p.underlyingPrice != null) g.underlyingPrice = p.underlyingPrice;
  }
  return [...map.values()];
}

type SortCol = "symbol" | "mktValue" | "pct" | "nominal" | "spot";

function sortGroups(
  groups: SymbolGroup[],
  col: SortCol,
  asc: boolean,
): SymbolGroup[] {
  const cmp = (a: SymbolGroup, b: SymbolGroup): number => {
    switch (col) {
      case "symbol":
        return a.symbol.localeCompare(b.symbol);
      case "mktValue":
        return a.totalMarketValue - b.totalMarketValue;
      case "pct":
        return a.totalPct - b.totalPct;
      case "nominal":
        return Math.abs(a.netNominal) - Math.abs(b.netNominal);
      case "spot":
        return (a.underlyingPrice ?? 0) - (b.underlyingPrice ?? 0);
      default:
        return 0;
    }
  };
  const sorted = [...groups].sort(cmp);
  return asc ? sorted : sorted.reverse();
}

const modifyBtnStyle: React.CSSProperties = {
  padding: "3px 8px",
  fontSize: 11,
  borderRadius: 4,
  border: "1px solid #334155",
  background: "transparent",
  color: "#94a3b8",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const th: React.CSSProperties = {
  padding: "10px 12px",
  fontSize: 11,
  fontWeight: 600,
  color: "#94a3b8",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};
const td: React.CSSProperties = { padding: "6px 12px", fontSize: 13 };
const right: React.CSSProperties = { textAlign: "right" };
const tabNums: React.CSSProperties = { fontVariantNumeric: "tabular-nums" };

interface PortfolioProps {
  onModifyPosition?: (draft: OrderFormDraft) => void;
}

function positionToDraft(p: PortfolioPosition): OrderFormDraft {
  const isOpt = isOption(p);
  return {
    symbol: underlying(p),
    securityType: isOpt ? "OPTION" : "EQUITY",
    optionType: isOpt ? (p.optionType as "CALL" | "PUT") : undefined,
    strikePrice: isOpt ? p.strikePrice : undefined,
    expirationDate: isOpt ? p.expirationDate : undefined,
    action: p.quantity > 0 ? "SELL" : "BUY_TO_COVER",
    quantity: Math.abs(p.quantity),
  };
}

export default function Portfolio({ onModifyPosition }: PortfolioProps) {
  const { data, isLoading, error, refetch, isFetching } = usePortfolio();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sortCol, setSortCol] = useState<SortCol>("nominal");
  const [sortAsc, setSortAsc] = useState(false);

  const errorMsg = error
    ? (error as Error).message || "Failed to load portfolio"
    : "";
  const positions = data?.positions ?? [];
  const rawGroups = buildGroups(positions);
  const groups = sortGroups(rawGroups, sortCol, sortAsc);
  const totalNominal = positions.reduce((s, p) => s + (p.nominalValue ?? 0), 0);

  const toggle = (sym: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(sym) ? next.delete(sym) : next.add(sym);
      return next;
    });

  const toggleSort = (col: SortCol) => {
    if (sortCol === col) setSortAsc((v) => !v);
    else {
      setSortCol(col);
      setSortAsc(col === "symbol");
    }
  };

  const arrow = (col: SortCol) =>
    sortCol === col ? (sortAsc ? " ▴" : " ▾") : "";

  return (
    <div>
      <style>{`
        .ptf-row { transition: background 0.1s; }
        .ptf-row:hover { background: rgba(51,65,85,0.5) !important; }
        .ptf-th { cursor: pointer; user-select: none; }
        .ptf-th:hover { color: #e2e8f0 !important; }
      `}</style>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 24,
        }}
      >
        <h2 style={{ fontSize: 20, fontWeight: 600, color: "#fff" }}>
          Portfolio
        </h2>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          style={{
            padding: "6px 12px",
            fontSize: 13,
            borderRadius: 8,
            background: "#334155",
            border: 0,
            color: "#cbd5e1",
            cursor: "pointer",
            opacity: isFetching ? 0.5 : 1,
          }}
        >
          {isFetching ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {errorMsg && (
        <div
          style={{
            marginBottom: 16,
            padding: 16,
            background: "rgba(239,68,68,0.15)",
            border: "1px solid #ef4444",
            borderRadius: 8,
            color: "#f87171",
            fontSize: 13,
          }}
        >
          {errorMsg}
        </div>
      )}

      {isLoading && (
        <div
          style={{
            marginBottom: 16,
            padding: 16,
            background: "#1e293b",
            border: "1px solid #334155",
            borderRadius: 8,
            color: "#cbd5e1",
            fontSize: 13,
          }}
        >
          Loading portfolio...
        </div>
      )}

      {data && !isLoading && (
        <>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 16,
              marginBottom: 20,
            }}
          >
            <SummaryCard
              label="Total Market Value"
              value={fmt$(data.totalMarketValue)}
            />
            <SummaryCard label="Positions" value={String(positions.length)} />
            <SummaryCard
              label="Net Nominal Exposure"
              value={fmt$(totalNominal, { sign: true })}
              style={nominalColor(totalNominal)}
            />
          </div>

          {groups.length === 0 ? (
            <p style={{ color: "#94a3b8", fontSize: 13 }}>
              No positions found.
            </p>
          ) : (
            <div
              style={{
                overflowX: "auto",
                borderRadius: 8,
                border: "1px solid #334155",
              }}
            >
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 13,
                }}
              >
                <thead>
                  <tr
                    style={{
                      background: "rgba(30,41,59,0.8)",
                      textAlign: "left",
                    }}
                  >
                    <ThSort
                      label="Symbol"
                      col="symbol"
                      cur={sortCol}
                      asc={sortAsc}
                      onClick={toggleSort}
                    />
                    <th style={th}>Type</th>
                    <th style={th}>Detail</th>
                    <th style={{ ...th, ...right }}>Qty</th>
                    <ThSort
                      label="Mkt Value"
                      col="mktValue"
                      cur={sortCol}
                      asc={sortAsc}
                      onClick={toggleSort}
                      align="right"
                    />
                    <ThSort
                      label="%"
                      col="pct"
                      cur={sortCol}
                      asc={sortAsc}
                      onClick={toggleSort}
                      align="right"
                    />
                    <ThSort
                      label="Nominal"
                      col="nominal"
                      cur={sortCol}
                      asc={sortAsc}
                      onClick={toggleSort}
                      align="right"
                    />
                    <ThSort
                      label="Spot"
                      col="spot"
                      cur={sortCol}
                      asc={sortAsc}
                      onClick={toggleSort}
                      align="right"
                    />
                    {onModifyPosition && <th style={th} />}
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => {
                    const legCount = (g.equity ? 1 : 0) + g.options.length;
                    const multi = legCount > 1;
                    const open = !collapsed.has(g.symbol);

                    return (
                      <React.Fragment key={g.symbol}>
                        {/* Group header */}
                        <tr
                          className="ptf-row"
                          onClick={multi ? () => toggle(g.symbol) : undefined}
                          style={{
                            background: "rgba(30,41,59,0.5)",
                            borderTop: "1px solid #334155",
                            cursor: multi ? "pointer" : "default",
                          }}
                        >
                          <td
                            style={{
                              ...td,
                              fontWeight: 600,
                              color: "#fff",
                              fontSize: 14,
                            }}
                          >
                            {multi && (
                              <span
                                style={{
                                  display: "inline-block",
                                  width: 14,
                                  fontSize: 10,
                                  color: "#64748b",
                                  transform: open
                                    ? "rotate(0)"
                                    : "rotate(-90deg)",
                                  transition: "transform 0.15s",
                                }}
                              >
                                {"\u25BE"}
                              </span>
                            )}
                            {g.symbol}
                          </td>
                          <td style={{ ...td, color: "#64748b", fontSize: 11 }}>
                            {multi
                              ? `${legCount} legs`
                              : g.equity
                                ? "EQ"
                                : (g.options[0]?.optionType ?? "OPT")}
                          </td>
                          <td style={td} />
                          <td
                            style={{
                              ...td,
                              ...right,
                              ...tabNums,
                              color: "#94a3b8",
                            }}
                          >
                            {!multi &&
                              (g.equity?.quantity ?? g.options[0]?.quantity)}
                          </td>
                          <td
                            style={{
                              ...td,
                              ...right,
                              ...tabNums,
                              color: "#e2e8f0",
                              fontWeight: 500,
                            }}
                          >
                            {fmt$(g.totalMarketValue)}
                          </td>
                          <td
                            style={{
                              ...td,
                              ...right,
                              ...tabNums,
                              color: "#94a3b8",
                            }}
                          >
                            {fmtPct(g.totalPct)}
                          </td>
                          <td
                            style={{
                              ...td,
                              ...right,
                              ...tabNums,
                              fontWeight: 600,
                              ...(nominalColor(g.netNominal)
                                ? {
                                    color:
                                      g.netNominal > 0
                                        ? "#4ade80"
                                        : g.netNominal < 0
                                          ? "#f87171"
                                          : undefined,
                                  }
                                : {}),
                            }}
                          >
                            {fmt$(g.netNominal, { sign: true })}
                          </td>
                          <td
                            style={{
                              ...td,
                              ...right,
                              ...tabNums,
                              color: "#64748b",
                              fontSize: 11,
                            }}
                          >
                            {g.underlyingPrice != null
                              ? `$${g.underlyingPrice.toFixed(2)}`
                              : "\u2014"}
                          </td>
                          {onModifyPosition && (
                            <td style={{ ...td, textAlign: "center" }}>
                              {!multi && (g.equity || g.options[0]) && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onModifyPosition(
                                      positionToDraft(g.equity ?? g.options[0]),
                                    );
                                  }}
                                  style={modifyBtnStyle}
                                  title="Open in Create Order"
                                >
                                  Modify
                                </button>
                              )}
                            </td>
                          )}
                        </tr>

                        {/* Leg rows for multi-leg groups */}
                        {multi && open && (
                          <>
                            {g.equity && (
                              <LegRow
                                type="EQ"
                                detail="Stock"
                                qty={g.equity.quantity}
                                mv={g.equity.marketValue}
                                pct={g.equity.pctOfPortfolio}
                                nominal={g.equity.nominalValue}
                                onModify={
                                  onModifyPosition
                                    ? () =>
                                        onModifyPosition(
                                          positionToDraft(g.equity!),
                                        )
                                    : undefined
                                }
                              />
                            )}
                            {g.options.map((o, i) => (
                              <LegRow
                                key={`${o.symbol}-${i}`}
                                type={o.optionType ?? "OPT"}
                                detail={optionLabel(o)}
                                qty={o.quantity}
                                mv={o.marketValue}
                                pct={o.pctOfPortfolio}
                                nominal={o.nominalValue}
                                onModify={
                                  onModifyPosition
                                    ? () => onModifyPosition(positionToDraft(o))
                                    : undefined
                                }
                              />
                            ))}
                          </>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr
                    style={{
                      background: "rgba(30,41,59,0.8)",
                      borderTop: "1px solid #475569",
                    }}
                  >
                    <td
                      colSpan={4}
                      style={{
                        ...td,
                        fontSize: 11,
                        fontWeight: 600,
                        color: "#94a3b8",
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                      }}
                    >
                      Total
                    </td>

                    <td
                      style={{
                        ...td,
                        ...right,
                        ...tabNums,
                        color: "#fff",
                        fontWeight: 600,
                      }}
                    >
                      {fmt$(data.totalMarketValue)}
                    </td>
                    <td
                      style={{ ...td, ...right, ...tabNums, color: "#94a3b8" }}
                    >
                      100%
                    </td>
                    <td
                      style={{
                        ...td,
                        ...right,
                        ...tabNums,
                        fontWeight: 600,
                        ...(totalNominal > 0
                          ? { color: "#4ade80" }
                          : totalNominal < 0
                            ? { color: "#f87171" }
                            : {}),
                      }}
                    >
                      {fmt$(totalNominal, { sign: true })}
                    </td>
                    <td colSpan={onModifyPosition ? 2 : 1} style={td} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          <p style={{ marginTop: 12, fontSize: 11, color: "#64748b" }}>
            Nominal = signed intrinsic exposure (equity: signed qty × spot;
            call: signed contracts × 100 × max(spot − strike, 0); put: signed
            contracts × 100 × max(strike − spot, 0)). Market value includes
            extrinsic value.
          </p>
        </>
      )}
    </div>
  );
}

function LegRow({
  type,
  detail,
  qty,
  mv,
  pct,
  nominal,
  onModify,
}: {
  type: string;
  detail: string;
  qty: number;
  mv?: number;
  pct?: number;
  nominal?: number;
  onModify?: () => void;
}) {
  const isOpt = type !== "EQ";
  return (
    <tr
      className="ptf-row"
      style={{ borderTop: "1px solid rgba(51,65,85,0.4)" }}
    >
      <td style={td} />
      <td style={td}>
        <span
          style={{
            fontSize: 11,
            padding: "1px 5px",
            borderRadius: 3,
            fontWeight: 500,
            background: isOpt ? "rgba(126,34,206,0.25)" : "#334155",
            color: isOpt ? "#c084fc" : "#94a3b8",
          }}
        >
          {type}
        </span>
      </td>
      <td style={{ ...td, color: "#cbd5e1" }}>{detail}</td>
      <td style={{ ...td, ...right, ...tabNums, color: "#94a3b8" }}>{qty}</td>
      <td style={{ ...td, ...right, ...tabNums, color: "#e2e8f0" }}>
        {fmt$(mv)}
      </td>
      <td style={{ ...td, ...right, ...tabNums, color: "#94a3b8" }}>
        {pct != null ? fmtPct(pct) : "\u2014"}
      </td>
      <td
        style={{
          ...td,
          ...right,
          ...tabNums,
          fontWeight: 500,
          ...(nominal != null && nominal > 0
            ? { color: "#4ade80" }
            : nominal != null && nominal < 0
              ? { color: "#f87171" }
              : {}),
        }}
      >
        {fmt$(nominal, { sign: true })}
      </td>
      {onModify ? (
        <td style={{ ...td, textAlign: "center" }}>
          <button
            type="button"
            onClick={onModify}
            style={modifyBtnStyle}
            title="Open in Create Order"
          >
            Modify
          </button>
        </td>
      ) : (
        <td style={td} />
      )}
    </tr>
  );
}

function SummaryCard({
  label,
  value,
  style,
}: {
  label: string;
  value: string;
  style?: string;
}) {
  return (
    <div
      style={{
        background: "rgba(30,41,59,0.8)",
        border: "1px solid #334155",
        borderRadius: 8,
        padding: "12px 16px",
      }}
    >
      <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 2 }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 600,
          color: "#fff",
          ...(style ? { color: style.replace("color: ", "") } : {}),
        }}
      >
        {value}
      </div>
    </div>
  );
}

function ThSort({
  label,
  col,
  cur,
  asc,
  onClick,
  align,
}: {
  label: string;
  col: SortCol;
  cur: SortCol;
  asc: boolean;
  onClick: (col: SortCol) => void;
  align?: "right";
}) {
  const active = cur === col;
  return (
    <th
      className="ptf-th"
      style={{
        ...th,
        ...(align === "right" ? right : {}),
        color: active ? "#e2e8f0" : "#94a3b8",
      }}
      onClick={() => onClick(col)}
    >
      {label}
      {active ? (asc ? " \u25B4" : " \u25BE") : ""}
    </th>
  );
}
