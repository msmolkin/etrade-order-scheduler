import { useQuery } from "@tanstack/react-query";
import { fetchExpiredOrders, type Order } from "../utils/api";
import { STALE } from "../utils/queryClient";

export const expiredOrdersQueryKey = (limit?: number) =>
  limit !== undefined ? (["orders-expired", limit] as const) : (["orders-expired"] as const);

export function useExpiredOrders(limit?: number) {
  return useQuery<Order[]>({
    queryKey: expiredOrdersQueryKey(limit),
    queryFn: () => fetchExpiredOrders(limit),
    staleTime: STALE.expiredOrders,
  });
}
