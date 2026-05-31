/**
 * Active-orders query. The WSProvider keeps this cache fresh by patching
 * individual rows on order_update events; this hook only fires a network
 * fetch on first mount, on tab focus, and on the configured stale interval.
 */
import { useQuery } from "@tanstack/react-query";
import { fetchOrders, type Order } from "../utils/api";
import { STALE } from "../utils/queryClient";

export interface OrdersFilters {
  accountId?: string;
  status?: string;
  scheduleEnabled?: boolean;
}

/** Stable cache key for the unfiltered list, used by WS patches and mutations. */
export const ordersQueryKey = (filters?: OrdersFilters) =>
  filters && Object.keys(filters).length > 0 ? (["orders", filters] as const) : (["orders"] as const);

export function useOrders(filters?: OrdersFilters) {
  return useQuery<Order[]>({
    queryKey: ordersQueryKey(filters),
    queryFn: () => fetchOrders(filters),
    staleTime: STALE.orders,
  });
}
