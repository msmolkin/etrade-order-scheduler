import { useQuery } from "@tanstack/react-query";
import { fetchPositionsCushions, type PositionCushion } from "../utils/api";
import { STALE } from "../utils/queryClient";

export const positionsCushionsQueryKey = (accountIdKey?: string) =>
  accountIdKey
    ? (["positions-cushions", accountIdKey] as const)
    : (["positions-cushions"] as const);

export function usePositionsCushion(accountIdKey?: string) {
  return useQuery<PositionCushion[]>({
    queryKey: positionsCushionsQueryKey(accountIdKey),
    queryFn: () => fetchPositionsCushions(accountIdKey),
    staleTime: STALE.positions,
  });
}
