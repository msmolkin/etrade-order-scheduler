import dotenv from 'dotenv';
import { query } from '../server/database/client.js';

dotenv.config();

async function checkAllOrders() {
  console.log('Checking all orders and their status...\n');

  // Get all orders with schedule info
  const allOrders = await query(`
    SELECT 
      o.id,
      o.symbol,
      o.action,
      o.quantity,
      o.status,
      o.schedule_enabled,
      o.session_time,
      o.scheduled_for,
      o.last_error,
      o.retry_count,
      o.max_retries,
      o.created_at,
      o.updated_at,
      l.scheduled_time as lock_scheduled_time,
      l.locked as lock_locked,
      l.locked_by,
      l.locked_at
    FROM orders o
    LEFT JOIN scheduled_order_locks l ON o.id = l.order_id
    ORDER BY o.created_at DESC
    LIMIT 20
  `);

  console.log(`Found ${allOrders.rows.length} recent orders:\n`);

  for (const order of allOrders.rows) {
    console.log(`Order ID: ${order.id}`);
    console.log(`  Symbol: ${order.symbol}`);
    console.log(`  Action: ${order.action} ${order.quantity} shares`);
    console.log(`  Status: ${order.status}`);
    console.log(`  Schedule enabled: ${order.schedule_enabled}`);
    if (order.schedule_enabled) {
      console.log(`  Session: ${order.session_time}`);
      console.log(`  Scheduled for: ${order.scheduled_for ? new Date(order.scheduled_for).toLocaleString('en-US', { timeZone: 'America/New_York' }) : 'N/A'}`);
      console.log(`  Lock scheduled_time: ${order.lock_scheduled_time ? new Date(order.lock_scheduled_time).toLocaleString('en-US', { timeZone: 'America/New_York' }) : 'N/A'}`);
      console.log(`  Lock status: ${order.lock_locked ? `LOCKED by ${order.locked_by} at ${order.locked_at ? new Date(order.locked_at).toISOString() : 'N/A'}` : 'UNLOCKED'}`);
    }
    if (order.last_error) {
      console.log(`  Last error: ${order.last_error}`);
    }
    console.log(`  Retry count: ${order.retry_count}/${order.max_retries}`);
    console.log(`  Created: ${new Date(order.created_at).toLocaleString('en-US', { timeZone: 'America/New_York' })}`);
    console.log(`  Updated: ${new Date(order.updated_at).toLocaleString('en-US', { timeZone: 'America/New_York' })}`);
    console.log('');
  }

  // Check all order_executions
  const allExecutions = await query(`
    SELECT 
      oe.id,
      oe.order_id,
      oe.status,
      oe.error_message,
      oe.execution_time,
      oe.etrade_order_id,
      o.symbol,
      o.session_time
    FROM order_executions oe
    JOIN orders o ON oe.order_id = o.id
    ORDER BY oe.execution_time DESC
    LIMIT 20
  `);

  console.log(`\nRecent order executions: ${allExecutions.rows.length}\n`);
  for (const exec of allExecutions.rows) {
    console.log(`Execution ID: ${exec.id}`);
    console.log(`  Order ID: ${exec.order_id} (${exec.symbol}, ${exec.session_time})`);
    console.log(`  Status: ${exec.status}`);
    console.log(`  Time: ${new Date(exec.execution_time).toLocaleString('en-US', { timeZone: 'America/New_York' })}`);
    if (exec.etrade_order_id) {
      console.log(`  E*TRADE Order ID: ${exec.etrade_order_id}`);
    }
    if (exec.error_message) {
      console.log(`  Error: ${exec.error_message}`);
    }
    console.log('');
  }

  // Check for SCHEDULED orders that might be stuck
  const scheduledOrders = await query(`
    SELECT 
      o.id,
      o.symbol,
      o.action,
      o.quantity,
      o.status,
      o.session_time,
      o.scheduled_for,
      l.scheduled_time,
      l.locked,
      l.locked_by,
      l.locked_at
    FROM orders o
    LEFT JOIN scheduled_order_locks l ON o.id = l.order_id
    WHERE o.schedule_enabled = true
    AND o.status = 'SCHEDULED'
    ORDER BY o.scheduled_for ASC
  `);

  console.log(`\nAll SCHEDULED orders: ${scheduledOrders.rows.length}\n`);
  for (const order of scheduledOrders.rows) {
    const scheduledFor = order.scheduled_for
      ? new Date(order.scheduled_for).toLocaleString('en-US', { timeZone: 'America/New_York' })
      : 'N/A';
    const lockTime = order.scheduled_time
      ? new Date(order.scheduled_time).toLocaleString('en-US', { timeZone: 'America/New_York' })
      : 'N/A';
    const now = new Date();
    const scheduledDate = order.scheduled_for ? new Date(order.scheduled_for) : null;
    const isOverdue = scheduledDate && scheduledDate < now;

    console.log(`Order ${order.id} (${order.symbol}): ${order.action} ${order.quantity}`);
    console.log(`  Status: ${order.status}${isOverdue ? ' (OVERDUE)' : ''}`);
    console.log(`  Session: ${order.session_time}`);
    console.log(`  Scheduled for: ${scheduledFor}`);
    console.log(`  Lock scheduled_time: ${lockTime}`);
    console.log(`  Locked: ${order.locked ? `Yes by ${order.locked_by} at ${order.locked_at ? new Date(order.locked_at).toISOString() : 'N/A'}` : 'No'}`);
    console.log('');
  }

  process.exit(0);
}

checkAllOrders().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
