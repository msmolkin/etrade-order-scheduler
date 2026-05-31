import { v4 as uuidv4 } from "uuid";
import { query, transaction } from "../database/client.js";
import type {
  Order,
  OrderStatus,
  SessionTime,
} from "../../shared/types/index.js";
import type pg from "pg";

export class OrderService {
  async createOrder(
    order: Omit<Order, "id" | "parentId" | "createdAt" | "updatedAt"> & {
      parentId?: string;
    },
  ): Promise<Order> {
    const id = uuidv4();
    const now = new Date();

    const result = await query<Order>(
      `INSERT INTO orders (
        id, account_id, symbol, security_type, option_symbol, option_type,
        strike_price, expiration_date, action, order_type, quantity,
        limit_price, stop_price, preferred_duration, actual_duration,
        requires_daily, session_time, scheduled_for, schedule_enabled, schedule_frequency, schedule_once,
        status, retry_count, max_retries, created_at, updated_at, notes,
        threshold_enabled, threshold_price, threshold_price_source, threshold_quantity,
        threshold_poll_interval_ms, threshold_log_file, sell_order_enabled,
        sell_order_threshold_price, sell_order_threshold_price_source, sell_order_quantity,
        sell_order_triggered_by_order_id, parent_id, only_fill_once, filled_quantity
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29,
        $30, $31, $32, $33, $34, $35, $36, $37, $38, COALESCE($39::uuid, $1::uuid),
        $40, $41
      ) RETURNING *`,
      [
        id,
        order.accountId,
        order.symbol,
        order.securityType,
        order.optionSymbol,
        order.optionType,
        order.strikePrice,
        order.expirationDate,
        order.action,
        order.orderType,
        order.quantity,
        order.limitPrice,
        order.stopPrice,
        order.preferredDuration,
        order.actualDuration,
        order.requiresDaily,
        order.sessionTime,
        order.scheduledFor,
        order.scheduleEnabled,
        order.scheduleFrequency,
        order.scheduleOnce ?? false,
        order.status,
        order.retryCount,
        order.maxRetries,
        now,
        now,
        order.notes,
        order.thresholdEnabled ?? false,
        order.thresholdPrice,
        order.thresholdPriceSource,
        order.thresholdQuantity,
        order.thresholdPollIntervalMs ?? 1000,
        order.thresholdLogFile,
        order.sellOrderEnabled ?? false,
        order.sellOrderThresholdPrice,
        order.sellOrderThresholdPriceSource,
        order.sellOrderQuantity,
        order.sellOrderTriggeredByOrderId,
        order.parentId ?? null,
        order.onlyFillOnce ?? true,
        order.filledQuantity ?? null,
      ],
    );

    // If scheduled, create lock entry
    if (order.scheduleEnabled && order.scheduledFor) {
      await this.createScheduleLock(id, order.scheduledFor, order.sessionTime);
    }

    return this.mapRowToOrder(result.rows[0]);
  }

  async getOrder(id: string): Promise<Order | null> {
    const result = await query<Order>("SELECT * FROM orders WHERE id = $1", [
      id,
    ]);
    return result.rows.length > 0 ? this.mapRowToOrder(result.rows[0]) : null;
  }

  async findExistingScheduledClone(
    parentId: string,
    scheduledFor: Date,
  ): Promise<Order | null> {
    const result = await query<Order>(
      `SELECT * FROM orders WHERE parent_id = $1 AND scheduled_for = $2 AND status IN ('SCHEDULED','PENDING') LIMIT 1`,
      [parentId, scheduledFor],
    );
    return result.rows.length > 0 ? this.mapRowToOrder(result.rows[0]) : null;
  }

  async lineageHasFilledOrder(parentId: string): Promise<boolean> {
    const result = await query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM orders
          WHERE parent_id = $1
            AND status = 'FILLED'
       ) AS "exists"`,
      [parentId],
    );
    return result.rows[0]?.exists ?? false;
  }

  /**
   * Single-statement Active-orders query with parent rollup.
   *
   * Returns orders in actionable statuses plus two lineage aggregates so the client
   * can render the OrderThread without a follow-up roundtrip:
   *   - parent_symbol  (symbol of the parent recurring template, when this row is a clone)
   *   - lineage_count  (number of children with the same parent_id)
   *   - last_fill_at   (most recent filled_at across the lineage)
   *
   * Uses idx_orders_status_scheduled_for for the WHERE/ORDER BY.
   */
  async getActiveOrdersWithLineage(limit: number = 500): Promise<Order[]> {
    const result = await query<any>(
      `SELECT o.*,
              parent.symbol AS parent_symbol,
              (SELECT COUNT(*) FROM orders c WHERE c.parent_id = o.id) AS lineage_count,
              (SELECT MAX(filled_at) FROM orders c WHERE c.parent_id = o.id AND c.status = 'FILLED') AS last_fill_at
         FROM orders o
         LEFT JOIN orders parent ON o.parent_id = parent.id
        WHERE o.status != 'DELETED'
          AND o.status IN ('SCHEDULED','PENDING','SUBMITTED','PARTIALLY_FILLED','PAUSED','REJECTED')
        ORDER BY o.scheduled_for ASC NULLS LAST
        LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => {
      const order = this.mapRowToOrder(row);
      order.parentSymbol = row.parent_symbol ?? null;
      order.lineageCount =
        row.lineage_count != null ? Number(row.lineage_count) : 0;
      order.lastFillAt = row.last_fill_at ?? null;
      return order;
    });
  }

  async getOrders(filters: {
    accountId?: string;
    status?: OrderStatus;
    scheduleEnabled?: boolean;
    limit?: number;
  }): Promise<Order[]> {
    let sql = "SELECT * FROM orders WHERE status != 'DELETED'";
    const params: any[] = [];
    let paramCount = 1;

    if (filters.accountId) {
      sql += ` AND account_id = $${paramCount++}`;
      params.push(filters.accountId);
    }

    if (filters.status) {
      sql += ` AND status = $${paramCount++}`;
      params.push(filters.status);
    }

    if (filters.scheduleEnabled !== undefined) {
      sql += ` AND schedule_enabled = $${paramCount++}`;
      params.push(filters.scheduleEnabled);
    }

    sql += " ORDER BY created_at DESC";

    if (filters.limit) {
      sql += ` LIMIT $${paramCount++}`;
      params.push(filters.limit);
    }

    const result = await query<Order>(sql, params);
    return result.rows.map((row) => this.mapRowToOrder(row));
  }

  /**
   * Children of a parent recurring order, ordered newest-first.
   * Used by the OrderThread expand panel to render the lineage history.
   * Limit defaults to 10 - the strip shows 6 cells but we fetch a few extra
   * so the inline expand can scroll without a follow-up roundtrip.
   */
  async getChildOrders(parentId: string, limit: number = 10): Promise<Order[]> {
    const result = await query<Order>(
      `SELECT * FROM orders
       WHERE parent_id = $1
         AND id != $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [parentId, limit],
    );
    return result.rows.map((row) => this.mapRowToOrder(row));
  }

  async getExpiredOrders(limit: number = 50): Promise<Order[]> {
    const result = await query<Order>(
      `SELECT * FROM orders
       WHERE status = 'EXPIRED'
       ORDER BY expires_at DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => this.mapRowToOrder(row));
  }

  async getScheduledOrders(
    time: Date,
    sessionTime: SessionTime,
  ): Promise<Order[]> {
    const result = await query<Order>(
      `SELECT o.* FROM orders o
       INNER JOIN scheduled_order_locks l ON o.id = l.order_id
       WHERE o.schedule_enabled = true
       AND o.status = 'SCHEDULED'
       AND l.session_time = $1
       AND l.scheduled_time <= $2
       AND l.locked = false
       ORDER BY l.scheduled_time ASC`,
      [sessionTime, time],
    );
    return result.rows.map((row) => this.mapRowToOrder(row));
  }

  /** Orders with scheduled_time <= time (any session), for arbitrary-time scheduling. */
  async getOrdersDueByTime(time: Date): Promise<Order[]> {
    const result = await query<Order>(
      `SELECT o.* FROM orders o
       INNER JOIN scheduled_order_locks l ON o.id = l.order_id
       WHERE o.schedule_enabled = true
       AND o.status = 'SCHEDULED'
       AND l.scheduled_time <= $1
       AND l.locked = false
       ORDER BY l.scheduled_time ASC`,
      [time],
    );
    return result.rows.map((row) => this.mapRowToOrder(row));
  }

  async updateOrderStatus(
    id: string,
    status: OrderStatus,
    details?: {
      etradeOrderId?: string;
      lastError?: string;
      submittedAt?: Date;
      filledAt?: Date;
      cancelledAt?: Date;
      expiresAt?: Date;
    },
  ): Promise<void> {
    const fields: string[] = ["status = $2"];
    const params: any[] = [id, status];
    let paramCount = 3;

    if (details?.etradeOrderId) {
      fields.push(`etrade_order_id = $${paramCount++}`);
      params.push(details.etradeOrderId);
    }

    if (details?.lastError) {
      fields.push(`last_error = $${paramCount++}`);
      params.push(details.lastError);
    }

    if (details?.submittedAt) {
      fields.push(`submitted_at = $${paramCount++}`);
      params.push(details.submittedAt);
    }

    if (details?.filledAt) {
      fields.push(`filled_at = $${paramCount++}`);
      params.push(details.filledAt);
    }

    if (details?.cancelledAt) {
      fields.push(`cancelled_at = $${paramCount++}`);
      params.push(details.cancelledAt);
    }

    if (details?.expiresAt) {
      fields.push(`expires_at = $${paramCount++}`);
      params.push(details.expiresAt);
    }

    await query(`UPDATE orders SET ${fields.join(", ")} WHERE id = $1`, params);
  }

  async updateOrderExpiration(id: string, expirationDate: Date): Promise<void> {
    await query("UPDATE orders SET expiration_date = $2 WHERE id = $1", [
      id,
      expirationDate,
    ]);
  }

  async updateOrderQuantity(id: string, quantity: number): Promise<void> {
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new Error("Quantity must be a positive integer");
    }
    await query(
      "UPDATE orders SET quantity = $2, updated_at = NOW() WHERE id = $1",
      [id, quantity],
    );
  }

  async updateOrderLimitPrice(id: string, limitPrice: number): Promise<void> {
    if (
      typeof limitPrice !== "number" ||
      !Number.isFinite(limitPrice) ||
      limitPrice < 0
    ) {
      throw new Error("Limit price must be a non-negative number");
    }
    await query(
      "UPDATE orders SET limit_price = $2, updated_at = NOW() WHERE id = $1",
      [id, limitPrice],
    );
  }

  async updateOrderOnlyFillOnce(id: string, value: boolean): Promise<void> {
    await query(
      "UPDATE orders SET only_fill_once = $2, updated_at = NOW() WHERE id = $1",
      [id, value],
    );
  }

  async updateOrderFilledQuantity(
    id: string,
    filledQuantity: number,
  ): Promise<void> {
    await query(
      "UPDATE orders SET filled_quantity = $2, updated_at = NOW() WHERE id = $1",
      [id, filledQuantity],
    );
  }

  /**
   * Cancel future scheduled clones in a lineage (same parent_id), excluding
   * the order that just filled. Used when onlyFillOnce orders fill.
   * Returns the IDs that were cancelled.
   */
  async cancelClonesInLineage(
    parentId: string,
    exceptId: string,
  ): Promise<string[]> {
    const result = await query<{ id: string }>(
      `UPDATE orders
         SET status = 'CANCELLED',
             cancelled_at = NOW(),
             updated_at = NOW()
       WHERE parent_id = $1
         AND id <> $2
         AND status IN ('SCHEDULED', 'PENDING', 'PAUSED')
       RETURNING id`,
      [parentId, exceptId],
    );
    return result.rows.map((r) => r.id);
  }

  /**
   * Find the next SCHEDULED clone in a lineage (other than `exceptId`) and
   * shrink its quantity to `newQuantity`. Used when onlyFillOnce orders
   * partially fill: tomorrow's clone picks up the unfilled remainder.
   * Returns the updated clone's id, or null when no future clone exists.
   */
  async updateNextCloneQuantity(
    parentId: string,
    exceptId: string,
    newQuantity: number,
  ): Promise<string | null> {
    if (!Number.isInteger(newQuantity) || newQuantity < 1) return null;
    const result = await query<{ id: string }>(
      `UPDATE orders
         SET quantity = $3, updated_at = NOW()
       WHERE id = (
         SELECT id FROM orders
         WHERE parent_id = $1
           AND id <> $2
           AND status IN ('SCHEDULED', 'PENDING')
         ORDER BY scheduled_for ASC NULLS LAST, created_at ASC
         LIMIT 1
       )
       RETURNING id`,
      [parentId, exceptId, newQuantity],
    );
    return result.rows[0]?.id ?? null;
  }

  async incrementRetryCount(id: string): Promise<number> {
    const result = await query<{ retry_count: number }>(
      "UPDATE orders SET retry_count = retry_count + 1 WHERE id = $1 RETURNING retry_count",
      [id],
    );
    return result.rows[0].retry_count;
  }

  async deleteOrder(id: string): Promise<void> {
    await query(
      "UPDATE orders SET status = 'DELETED', updated_at = NOW() WHERE id = $1",
      [id],
    );
  }

  async getDeletedOrders(limit: number = 50): Promise<Order[]> {
    const result = await query<Order>(
      `SELECT * FROM orders
       WHERE status = 'DELETED'
       ORDER BY updated_at DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => this.mapRowToOrder(row));
  }

  async restoreOrder(id: string): Promise<Order | null> {
    const result = await query<Order>(
      "UPDATE orders SET status = 'PENDING', updated_at = NOW() WHERE id = $1 AND status = 'DELETED' RETURNING *",
      [id],
    );
    return result.rows.length > 0 ? this.mapRowToOrder(result.rows[0]) : null;
  }

  async permanentlyDeleteOrder(id: string): Promise<void> {
    await query("DELETE FROM orders WHERE id = $1 AND status = 'DELETED'", [
      id,
    ]);
  }

  async pauseAllScheduled(): Promise<number> {
    const result = await query(
      "UPDATE orders SET status = 'PAUSED', updated_at = NOW() WHERE status = 'SCHEDULED' RETURNING id",
    );
    return result.rowCount ?? 0;
  }

  async resumeAllPaused(): Promise<number> {
    const result = await query(
      "UPDATE orders SET status = 'SCHEDULED', updated_at = NOW() WHERE status = 'PAUSED' RETURNING id",
    );
    return result.rowCount ?? 0;
  }

  async pauseOrder(id: string): Promise<void> {
    await query(
      "UPDATE orders SET status = 'PAUSED', updated_at = NOW() WHERE id = $1 AND status = 'SCHEDULED'",
      [id],
    );
  }

  async resumeOrder(id: string): Promise<void> {
    await query(
      "UPDATE orders SET status = 'SCHEDULED', updated_at = NOW() WHERE id = $1 AND status = 'PAUSED'",
      [id],
    );
  }

  async acquireLock(orderId: string, lockerId: string): Promise<boolean> {
    return transaction(async (client: pg.PoolClient) => {
      // First, ensure lock record exists (for immediate submissions)
      await client.query(
        `INSERT INTO scheduled_order_locks (order_id, scheduled_time, session_time, locked, locked_by, locked_at)
         VALUES ($1, NOW(), 'MARKET', false, NULL, NULL)
         ON CONFLICT (order_id) DO NOTHING`,
        [orderId],
      );

      // Now try to acquire the lock
      const result = await client.query(
        `UPDATE scheduled_order_locks
         SET locked = true, locked_by = $2, locked_at = NOW()
         WHERE order_id = $1 AND locked = false
         RETURNING order_id`,
        [orderId, lockerId],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async releaseLock(orderId: string): Promise<void> {
    await query(
      "UPDATE scheduled_order_locks SET locked = false, locked_by = NULL, locked_at = NULL WHERE order_id = $1",
      [orderId],
    );
  }

  async cleanupExpiredLocks(): Promise<void> {
    await query("SELECT cleanup_expired_locks()");
  }

  async logExecution(
    orderId: string,
    status: OrderStatus,
    details?: {
      etradeOrderId?: string;
      filledQuantity?: number;
      averagePrice?: number;
      errorMessage?: string;
    },
  ): Promise<void> {
    await query(
      `INSERT INTO order_executions (
        order_id, etrade_order_id, status, filled_quantity, average_price, error_message
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        orderId,
        details?.etradeOrderId,
        status,
        details?.filledQuantity,
        details?.averagePrice,
        details?.errorMessage,
      ],
    );
  }

  private async createScheduleLock(
    orderId: string,
    scheduledTime: Date,
    sessionTime: SessionTime,
  ): Promise<void> {
    await query(
      `INSERT INTO scheduled_order_locks (order_id, scheduled_time, session_time)
       VALUES ($1, $2, $3)
       ON CONFLICT (order_id) DO UPDATE
       SET scheduled_time = $2, session_time = $3`,
      [orderId, scheduledTime, sessionTime],
    );
  }

  /**
   * Find option orders whose underlying contract has expired.
   * An option is considered expired once 8 PM Eastern on its expiration_date has passed.
   * Only returns orders still in actionable statuses (PENDING, SCHEDULED).
   */
  async getOptionOrdersPastExpiration(): Promise<Order[]> {
    const result = await query<Order>(
      `SELECT * FROM orders
       WHERE security_type = 'OPTION'
       AND expiration_date IS NOT NULL
       AND status IN ('PENDING', 'SCHEDULED', 'PAUSED')
       AND (expiration_date::date + INTERVAL '20 hours') AT TIME ZONE 'America/New_York' < NOW()
       ORDER BY expiration_date ASC`,
    );
    return result.rows.map((row) => this.mapRowToOrder(row));
  }

  async getActiveThresholdOrders(): Promise<Order[]> {
    const result = await query<Order>(
      `SELECT * FROM orders
       WHERE threshold_enabled = true
       AND status IN ('PENDING', 'SCHEDULED', 'PAUSED')
       ORDER BY created_at ASC`,
    );
    return result.rows.map((row) => this.mapRowToOrder(row));
  }

  async getSellOrdersForBuyOrder(buyOrderId: string): Promise<Order[]> {
    const result = await query<Order>(
      `SELECT * FROM orders
       WHERE sell_order_enabled = true
       AND sell_order_triggered_by_order_id = $1
       AND status IN ('PENDING', 'SCHEDULED', 'PAUSED')`,
      [buyOrderId],
    );
    return result.rows.map((row) => this.mapRowToOrder(row));
  }

  /**
   * Slice 6.3: re-queue orders that were parked at PAUSED with the
   * sentinel lastError "queued for auth recovery". Called from the
   * auth-restored code paths (renewAccessToken success and
   * completeAutoAuthSession success). Returns the IDs that were flipped
   * back to SCHEDULED so callers can broadcast targeted order_update
   * events if they want.
   */
  async requeueAfterAuthRestore(): Promise<string[]> {
    // For recurring orders whose scheduled_for is >1h stale, advance to
    // tomorrow instead of firing a catch-up burst. Non-recurring or
    // recent orders requeue normally.
    const staleThreshold = new Date(Date.now() - 60 * 60_000);
    const staleResult = await query<{ id: string }>(
      `UPDATE orders
         SET status = 'SCHEDULED',
             last_error = NULL,
             scheduled_for = (scheduled_for + INTERVAL '1 day'),
             updated_at = NOW()
       WHERE status = 'PAUSED'
         AND last_error = 'queued for auth recovery'
         AND schedule_enabled = true
         AND schedule_once = false
         AND scheduled_for < $1
       RETURNING id`,
      [staleThreshold],
    );
    if (staleResult.rows.length > 0) {
      console.log(
        `[auth-restore] skipped catch-up for ${staleResult.rows.length} stale recurring order(s), advanced to next day`,
      );
    }

    // Requeue the rest (recent orders, one-shot orders) normally
    const result = await query<{ id: string }>(
      `UPDATE orders
         SET status = 'SCHEDULED', last_error = NULL, updated_at = NOW()
       WHERE status = 'PAUSED' AND last_error = 'queued for auth recovery'
       RETURNING id`,
    );
    return [
      ...staleResult.rows.map((r) => r.id),
      ...result.rows.map((r) => r.id),
    ];
  }

  private mapRowToOrder(row: any): Order {
    return {
      id: row.id,
      parentId: row.parent_id,
      accountId: row.account_id,
      symbol: row.symbol,
      securityType: row.security_type,
      optionSymbol: row.option_symbol,
      optionType: row.option_type,
      strikePrice: row.strike_price ? parseFloat(row.strike_price) : undefined,
      expirationDate: row.expiration_date,
      action: row.action,
      orderType: row.order_type,
      quantity: row.quantity,
      limitPrice: row.limit_price ? parseFloat(row.limit_price) : undefined,
      stopPrice: row.stop_price ? parseFloat(row.stop_price) : undefined,
      preferredDuration: row.preferred_duration,
      actualDuration: row.actual_duration,
      requiresDaily: row.requires_daily,
      sessionTime: row.session_time,
      scheduledFor: row.scheduled_for,
      scheduleEnabled: row.schedule_enabled,
      scheduleFrequency: row.schedule_frequency ?? "DAILY",
      scheduleOnce: row.schedule_once ?? false,
      onlyFillOnce: row.only_fill_once ?? true,
      status: row.status,
      etradeOrderId: row.etrade_order_id,
      submittedAt: row.submitted_at,
      filledAt: row.filled_at,
      cancelledAt: row.cancelled_at,
      expiresAt: row.expires_at,
      filledQuantity:
        row.filled_quantity != null ? Number(row.filled_quantity) : undefined,
      lastError: row.last_error,
      retryCount: row.retry_count,
      maxRetries: row.max_retries,
      thresholdEnabled: row.threshold_enabled ?? false,
      thresholdPrice: row.threshold_price
        ? parseFloat(row.threshold_price)
        : undefined,
      thresholdPriceSource: row.threshold_price_source,
      thresholdQuantity: row.threshold_quantity,
      thresholdPollIntervalMs: row.threshold_poll_interval_ms ?? 1000,
      thresholdLogFile: row.threshold_log_file,
      sellOrderEnabled: row.sell_order_enabled ?? false,
      sellOrderThresholdPrice: row.sell_order_threshold_price
        ? parseFloat(row.sell_order_threshold_price)
        : undefined,
      sellOrderThresholdPriceSource: row.sell_order_threshold_price_source,
      sellOrderQuantity: row.sell_order_quantity,
      sellOrderTriggeredByOrderId: row.sell_order_triggered_by_order_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      notes: row.notes,
    };
  }
}
