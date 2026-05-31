/**
 * Slice 5.1 useCreateOrder hook.
 *
 * Thin react-query useMutation wrapper around the POST /api/orders endpoint.
 * On success the active-orders cache is invalidated so the new row shows up
 * in OrderList without waiting for the next focus refetch. The companion
 * useSubmitOrder() hook from useOrderMutations covers the second leg of the
 * preview-then-submit two-step.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createOrder, type Order } from "../utils/api";
import { ordersQueryKey } from "./useOrders";

export function useCreateOrder() {
  const qc = useQueryClient();
  return useMutation<Order, Error, Partial<Order>>({
    mutationFn: (payload) => createOrder(payload),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ordersQueryKey() });
    },
  });
}
