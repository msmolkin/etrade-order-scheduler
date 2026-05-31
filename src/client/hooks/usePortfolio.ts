import { useQuery } from "@tanstack/react-query";
import { fetchPortfolio, type PortfolioResponse } from "../utils/api";
import { STALE } from "../utils/queryClient";

export const portfolioQueryKey = (accountIdKey?: string) =>
  accountIdKey ? (["portfolio", accountIdKey] as const) : (["portfolio"] as const);

export function usePortfolio(accountIdKey?: string) {
  return useQuery<PortfolioResponse>({
    queryKey: portfolioQueryKey(accountIdKey),
    queryFn: () => fetchPortfolio(accountIdKey),
    staleTime: STALE.positions,
  });
}
