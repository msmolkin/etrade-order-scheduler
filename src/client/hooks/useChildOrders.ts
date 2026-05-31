/**
 * Slice 4.3 child-orders fetch.
 *
 * One react-query hook per parent recurring order. The OrderThread expand
 * panel mounts this lazily (enabled = isExpanded) so collapsed threads
 * make zero requests.
 *
 * Cached under ['orders-children', parentId] so two threads sharing a parent
 * (rare but possible) dedupe automatically. staleTime mirrors the active
 * orders preset; lineage history changes only when a child order moves
 * status, which the WS order_update event already pushes into ['orders'] -
 * we invalidate lineage caches there too in Slice 4.4 if needed, but for
 * now a 30s stale window plus refetch-on-focus is good enough.
 */
import { useQuery } from "@tanstack/react-query";
import { fetchChildOrders, type Order } from "../utils/api";
import { STALE } from "../utils/queryClient";

export const childOrdersQueryKey = (parentId: string, limit: number = 10) =>
  ["orders-children", parentId, limit] as const;

export function useChildOrders(parentId: string | null, limit: number = 10) {
  return useQuery<Order[]>({
    queryKey: childOrdersQueryKey(parentId ?? "", limit),
    queryFn: () => fetchChildOrders(parentId!, limit),
    enabled: !!parentId,
    staleTime: STALE.orders,
  });
}
