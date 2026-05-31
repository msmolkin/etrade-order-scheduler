import { useQuery } from "@tanstack/react-query";
import { fetchDeletedOrders, type Order } from "../utils/api";
import { STALE } from "../utils/queryClient";

export const deletedOrdersQueryKey = (limit?: number) =>
  limit !== undefined ? (["orders-deleted", limit] as const) : (["orders-deleted"] as const);

export function useDeletedOrders(limit?: number) {
  return useQuery<Order[]>({
    queryKey: deletedOrdersQueryKey(limit),
    queryFn: () => fetchDeletedOrders(limit),
    staleTime: STALE.deletedOrders,
  });
}
