import { v4 as uuidv4 } from 'uuid';
import { query, transaction } from '../database/client.js';
import type { Order, OrderStatus, SessionTime } from '../../shared/types/index.js';
import type pg from 'pg';

export class OrderService {
  async createOrder(order: Omit<Order, 'id' | 'createdAt' | 'updatedAt'>): Promise<Order> {
    const id = uuidv4();
    const now = new Date();

    const result = await query<Order>(
      `INSERT INTO orders (
        id, account_id, symbol, security_type, option_symbol, option_type,
        strike_price, expiration_date, action, order_type, quantity,
        limit_price, stop_price, preferred_duration, actual_duration,
        requires_daily, session_time, scheduled_for, schedule_enabled,
        status, retry_count, max_retries, created_at, updated_at, notes
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20, $21, $22, $23, $24, $25
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
        order.status,
        order.retryCount,
        order.maxRetries,
        now,
        now,
        order.notes,
      ]
    );

    // If scheduled, create lock entry
    if (order.scheduleEnabled && order.scheduledFor) {
      await this.createScheduleLock(id, order.scheduledFor, order.sessionTime);
    }

    return this.mapRowToOrder(result.rows[0]);
  }

  async getOrder(id: string): Promise<Order | null> {
    const result = await query<Order>('SELECT * FROM orders WHERE id = $1', [id]);
    return result.rows.length > 0 ? this.mapRowToOrder(result.rows[0]) : null;
  }

  async getOrders(filters: {
    accountId?: string;
    status?: OrderStatus;
    scheduleEnabled?: boolean;
    limit?: number;
  }): Promise<Order[]> {
    let sql = 'SELECT * FROM orders WHERE 1=1';
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

    sql += ' ORDER BY created_at DESC';

    if (filters.limit) {
      sql += ` LIMIT $${paramCount++}`;
      params.push(filters.limit);
    }

    const result = await query<Order>(sql, params);
    return result.rows.map((row) => this.mapRowToOrder(row));
  }

  async getExpiredOrders(limit: number = 50): Promise<Order[]> {
    const result = await query<Order>(
      `SELECT * FROM orders
       WHERE status = 'EXPIRED'
       ORDER BY expires_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => this.mapRowToOrder(row));
  }

  async getScheduledOrders(time: Date, sessionTime: SessionTime): Promise<Order[]> {
    const result = await query<Order>(
      `SELECT o.* FROM orders o
       INNER JOIN scheduled_order_locks l ON o.id = l.order_id
       WHERE o.schedule_enabled = true
       AND o.status = 'SCHEDULED'
       AND l.session_time = $1
       AND l.scheduled_time <= $2
       AND l.locked = false
       ORDER BY l.scheduled_time ASC`,
      [sessionTime, time]
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
    }
  ): Promise<void> {
    const fields: string[] = ['status = $2'];
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

    await query(
      `UPDATE orders SET ${fields.join(', ')} WHERE id = $1`,
      params
    );
  }

  async incrementRetryCount(id: string): Promise<number> {
    const result = await query<{ retry_count: number }>(
      'UPDATE orders SET retry_count = retry_count + 1 WHERE id = $1 RETURNING retry_count',
      [id]
    );
    return result.rows[0].retry_count;
  }

  async deleteOrder(id: string): Promise<void> {
    await query('DELETE FROM orders WHERE id = $1', [id]);
  }

  async acquireLock(orderId: string, lockerId: string): Promise<boolean> {
    return transaction(async (client: pg.PoolClient) => {
      // First, ensure lock record exists (for immediate submissions)
      await client.query(
        `INSERT INTO scheduled_order_locks (order_id, scheduled_time, session_time, locked, locked_by, locked_at)
         VALUES ($1, NOW(), 'MARKET', false, NULL, NULL)
         ON CONFLICT (order_id) DO NOTHING`,
        [orderId]
      );

      // Now try to acquire the lock
      const result = await client.query(
        `UPDATE scheduled_order_locks
         SET locked = true, locked_by = $2, locked_at = NOW()
         WHERE order_id = $1 AND locked = false
         RETURNING order_id`,
        [orderId, lockerId]
      );
      return result.rowCount > 0;
    });
  }

  async releaseLock(orderId: string): Promise<void> {
    await query(
      'UPDATE scheduled_order_locks SET locked = false, locked_by = NULL, locked_at = NULL WHERE order_id = $1',
      [orderId]
    );
  }

  async cleanupExpiredLocks(): Promise<void> {
    await query('SELECT cleanup_expired_locks()');
  }

  async logExecution(
    orderId: string,
    status: OrderStatus,
    details?: {
      etradeOrderId?: string;
      filledQuantity?: number;
      averagePrice?: number;
      errorMessage?: string;
    }
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
      ]
    );
  }

  private async createScheduleLock(
    orderId: string,
    scheduledTime: Date,
    sessionTime: SessionTime
  ): Promise<void> {
    await query(
      `INSERT INTO scheduled_order_locks (order_id, scheduled_time, session_time)
       VALUES ($1, $2, $3)
       ON CONFLICT (order_id) DO UPDATE
       SET scheduled_time = $2, session_time = $3`,
      [orderId, scheduledTime, sessionTime]
    );
  }

  private mapRowToOrder(row: any): Order {
    return {
      id: row.id,
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
      status: row.status,
      etradeOrderId: row.etrade_order_id,
      submittedAt: row.submitted_at,
      filledAt: row.filled_at,
      cancelledAt: row.cancelled_at,
      expiresAt: row.expires_at,
      lastError: row.last_error,
      retryCount: row.retry_count,
      maxRetries: row.max_retries,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      notes: row.notes,
    };
  }
}
