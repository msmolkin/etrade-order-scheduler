/**
 * Slice 3.3 optimistic mutations.
 *
 * Every mutation hook here implements the same Brief §1.3 pattern:
 *
 *   1. onMutate:  cancel in-flight ['orders'] queries; snapshot prev cache;
 *                 patch the affected row with a transient client-only status
 *                 (SUBMITTING / DELETING / PAUSING / RESUMING) so the UI
 *                 flashes a "working" pill immediately, no waiting.
 *   2. onError:   roll back to the snapshot.
 *   3. onSettled: invalidate ['orders'] (and friends) so the canonical
 *                 server state replaces the optimistic patch. The WS
 *                 order_update event from the server typically arrives
 *                 first; this is the belt-and-suspenders.
 *
 * The transient statuses live alongside the canonical Order.status enum.
 * OrderRow.tsx (Slice 4) will pick them up to render a flashing pill.
 * Existing OrderList renders them as a normal status string via
 * getStatusColor's default (gray pill) until Slice 4 lands - acceptable
 * because the WS update arrives within hundreds of ms.
 */
import { useMutation, useQueryClient, type UseMutationOptions } from "@tanstack/react-query";
import {
  deleteOrder,
  pauseAllOrders,
  pauseOrder,
  permanentlyDeleteOrder,
  restoreOrder,
  resumeAllOrders,
  resumeOrder,
  submitOrder,
  updateOrderLimitPrice,
  updateOrderOnlyFillOnce,
  updateOrderQuantity,
  type Order,
} from "../utils/api";
import { ordersQueryKey } from "./useOrders";
import { deletedOrdersQueryKey } from "./useDeletedOrders";
import { mergeById, removeById } from "../utils/queryClient";

export type TransientOrderStatus = "SUBMITTING" | "DELETING" | "PAUSING" | "RESUMING";

interface OptimisticContext {
  prevActive: Order[] | undefined;
  prevDeleted: Order[] | undefined;
}

/**
 * Mark a row with a transient client-only status. Other fields are kept
 * intact so OrderRow's existing rendering still works.
 */
function patchStatus(
  rows: Order[] | undefined,
  id: string,
  next: TransientOrderStatus,
): Order[] {
  return (rows ?? []).map((r) => (r.id === id ? { ...r, status: next as unknown as Order["status"] } : r));
}

async function snapshotAndCancel(qc: ReturnType<typeof useQueryClient>): Promise<OptimisticContext> {
  await Promise.all([
    qc.cancelQueries({ queryKey: ordersQueryKey() }),
    qc.cancelQueries({ queryKey: deletedOrdersQueryKey() }),
  ]);
  return {
    prevActive: qc.getQueryData<Order[]>(ordersQueryKey()),
    prevDeleted: qc.getQueryData<Order[]>(deletedOrdersQueryKey()),
  };
}

function rollback(qc: ReturnType<typeof useQueryClient>, ctx: OptimisticContext | undefined): void {
  if (!ctx) return;
  if (ctx.prevActive !== undefined) qc.setQueryData(ordersQueryKey(), ctx.prevActive);
  if (ctx.prevDeleted !== undefined) qc.setQueryData(deletedOrdersQueryKey(), ctx.prevDeleted);
}

function invalidateOrders(qc: ReturnType<typeof useQueryClient>): void {
  qc.invalidateQueries({ queryKey: ordersQueryKey() });
  qc.invalidateQueries({ queryKey: deletedOrdersQueryKey() });
}

function singleIdMutation<TResult>(
  fn: (id: string) => Promise<TResult>,
  transient: TransientOrderStatus,
  qc: ReturnType<typeof useQueryClient>,
): UseMutationOptions<TResult, Error, string, OptimisticContext> {
  return {
    mutationFn: fn,
    onMutate: async (id) => {
      const ctx = await snapshotAndCancel(qc);
      qc.setQueryData<Order[]>(ordersQueryKey(), (rows) => patchStatus(rows, id, transient));
      return ctx;
    },
    onError: (_err, _vars, ctx) => rollback(qc, ctx),
    onSettled: () => invalidateOrders(qc),
  };
}

export function useSubmitOrder() {
  const qc = useQueryClient();
  return useMutation(singleIdMutation(submitOrder, "SUBMITTING", qc));
}

export function usePauseOrder() {
  const qc = useQueryClient();
  return useMutation(singleIdMutation(pauseOrder, "PAUSING", qc));
}

export function useResumeOrder() {
  const qc = useQueryClient();
  return useMutation(singleIdMutation(resumeOrder, "RESUMING", qc));
}

/**
 * Soft delete: row hops from active -> deleted in the cache. We snapshot
 * both lists so the rollback is exact.
 */
export function useDeleteOrder() {
  const qc = useQueryClient();
  return useMutation<void, Error, string, OptimisticContext>({
    mutationFn: (id) => deleteOrder(id),
    onMutate: async (id) => {
      const ctx = await snapshotAndCancel(qc);
      const active = qc.getQueryData<Order[]>(ordersQueryKey()) ?? [];
      const target = active.find((o) => o.id === id);
      // Mark transient first so existing rows show the DELETING pill.
      qc.setQueryData<Order[]>(ordersQueryKey(), (rows) => patchStatus(rows, id, "DELETING"));
      // Then move it to the deleted list with the canonical DELETED status.
      if (target) {
        const deletedRow: Order = { ...target, status: "DELETED" };
        qc.setQueryData<Order[]>(ordersQueryKey(), (rows) => removeById(rows, id));
        qc.setQueryData<Order[]>(deletedOrdersQueryKey(), (rows) => mergeById(rows, deletedRow));
      }
      return ctx;
    },
    onError: (_err, _vars, ctx) => rollback(qc, ctx),
    onSettled: () => invalidateOrders(qc),
  });
}

export function useRestoreOrder() {
  const qc = useQueryClient();
  return useMutation<Order, Error, string, OptimisticContext>({
    mutationFn: (id) => restoreOrder(id),
    onMutate: async (id) => {
      const ctx = await snapshotAndCancel(qc);
      const deleted = qc.getQueryData<Order[]>(deletedOrdersQueryKey()) ?? [];
      const target = deleted.find((o) => o.id === id);
      if (target) {
        // Provisional active row; the WS update / invalidate corrects details.
        const restored: Order = { ...target, status: "PENDING" };
        qc.setQueryData<Order[]>(deletedOrdersQueryKey(), (rows) => removeById(rows, id));
        qc.setQueryData<Order[]>(ordersQueryKey(), (rows) => mergeById(rows, restored));
      }
      return ctx;
    },
    onError: (_err, _vars, ctx) => rollback(qc, ctx),
    onSettled: () => invalidateOrders(qc),
  });
}

export function usePermanentlyDeleteOrder() {
  const qc = useQueryClient();
  return useMutation<void, Error, string, OptimisticContext>({
    mutationFn: (id) => permanentlyDeleteOrder(id),
    onMutate: async (id) => {
      const ctx = await snapshotAndCancel(qc);
      qc.setQueryData<Order[]>(deletedOrdersQueryKey(), (rows) => removeById(rows, id));
      return ctx;
    },
    onError: (_err, _vars, ctx) => rollback(qc, ctx),
    onSettled: () => invalidateOrders(qc),
  });
}

export interface UpdateQuantityVars {
  orderId: string;
  quantity: number;
}

export function useUpdateOrderQuantity() {
  const qc = useQueryClient();
  return useMutation<Order, Error, UpdateQuantityVars, OptimisticContext>({
    mutationFn: ({ orderId, quantity }) => updateOrderQuantity(orderId, quantity),
    onMutate: async ({ orderId, quantity }) => {
      const ctx = await snapshotAndCancel(qc);
      qc.setQueryData<Order[]>(ordersQueryKey(), (rows) =>
        (rows ?? []).map((o) => (o.id === orderId ? { ...o, quantity } : o)),
      );
      return ctx;
    },
    onError: (_err, _vars, ctx) => rollback(qc, ctx),
    onSettled: () => invalidateOrders(qc),
  });
}

export interface UpdateOnlyFillOnceVars {
  orderId: string;
  onlyFillOnce: boolean;
}

export function useUpdateOrderOnlyFillOnce() {
  const qc = useQueryClient();
  return useMutation<Order, Error, UpdateOnlyFillOnceVars, OptimisticContext>({
    mutationFn: ({ orderId, onlyFillOnce }) =>
      updateOrderOnlyFillOnce(orderId, onlyFillOnce),
    onMutate: async ({ orderId, onlyFillOnce }) => {
      const ctx = await snapshotAndCancel(qc);
      qc.setQueryData<Order[]>(ordersQueryKey(), (rows) =>
        (rows ?? []).map((o) =>
          o.id === orderId ? { ...o, onlyFillOnce } : o,
        ),
      );
      return ctx;
    },
    onError: (_err, _vars, ctx) => rollback(qc, ctx),
    onSettled: () => invalidateOrders(qc),
  });
}

export interface UpdateLimitPriceVars {
  orderId: string;
  limitPrice: number;
}

export function useUpdateOrderLimitPrice() {
  const qc = useQueryClient();
  return useMutation<Order, Error, UpdateLimitPriceVars, OptimisticContext>({
    mutationFn: ({ orderId, limitPrice }) => updateOrderLimitPrice(orderId, limitPrice),
    onMutate: async ({ orderId, limitPrice }) => {
      const ctx = await snapshotAndCancel(qc);
      qc.setQueryData<Order[]>(ordersQueryKey(), (rows) =>
        (rows ?? []).map((o) => (o.id === orderId ? { ...o, limitPrice } : o)),
      );
      return ctx;
    },
    onError: (_err, _vars, ctx) => rollback(qc, ctx),
    onSettled: () => invalidateOrders(qc),
  });
}

/**
 * Bulk pause: every SCHEDULED row gets a PAUSING transient. The server
 * decides which ones it actually paused; the canonical state arrives via
 * the order_update WS event stream and the post-settle invalidate.
 */
export function usePauseAllOrders() {
  const qc = useQueryClient();
  return useMutation<{ paused: number }, Error, void, OptimisticContext>({
    mutationFn: () => pauseAllOrders(),
    onMutate: async () => {
      const ctx = await snapshotAndCancel(qc);
      qc.setQueryData<Order[]>(ordersQueryKey(), (rows) =>
        (rows ?? []).map((o) =>
          o.status === "SCHEDULED" && !o.lastError
            ? { ...o, status: "PAUSING" as unknown as Order["status"] }
            : o,
        ),
      );
      return ctx;
    },
    onError: (_err, _vars, ctx) => rollback(qc, ctx),
    onSettled: () => invalidateOrders(qc),
  });
}

export function useResumeAllOrders() {
  const qc = useQueryClient();
  return useMutation<{ resumed: number }, Error, void, OptimisticContext>({
    mutationFn: () => resumeAllOrders(),
    onMutate: async () => {
      const ctx = await snapshotAndCancel(qc);
      qc.setQueryData<Order[]>(ordersQueryKey(), (rows) =>
        (rows ?? []).map((o) =>
          o.status === "PAUSED"
            ? { ...o, status: "RESUMING" as unknown as Order["status"] }
            : o,
        ),
      );
      return ctx;
    },
    onError: (_err, _vars, ctx) => rollback(qc, ctx),
    onSettled: () => invalidateOrders(qc),
  });
}
