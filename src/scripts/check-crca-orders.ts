import dotenv from 'dotenv';
import { query } from '../server/database/client.js';

dotenv.config();

async function checkCRCAOrders() {
  console.log('Checking CRCA orders...\n');

  // Get all CRCA orders
  const orders = await query(`
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
      o.submitted_at,
      o.etrade_order_id,
      l.scheduled_time as lock_scheduled_time,
      l.locked,
      l.locked_by,
      l.locked_at
    FROM orders o
    LEFT JOIN scheduled_order_locks l ON o.id = l.order_id
    WHERE o.symbol = 'CRCA'
    ORDER BY o.created_at DESC
  `);

  console.log(`Found ${orders.rows.length} CRCA orders:\n`);

  for (const order of orders.rows) {
    const scheduledFor = order.scheduled_for
      ? new Date(order.scheduled_for).toLocaleString('en-US', { timeZone: 'America/New_York' })
      : 'N/A';
    const lockTime = order.lock_scheduled_time
      ? new Date(order.lock_scheduled_time).toLocaleString('en-US', { timeZone: 'America/New_York' })
      : 'N/A';
    const now = new Date();
    const scheduledDate = order.scheduled_for ? new Date(order.scheduled_for) : null;
    const isOverdue = scheduledDate && scheduledDate < now;

    console.log(`Order ID: ${order.id}`);
    console.log(`  Action: ${order.action} ${order.quantity} shares`);
    console.log(`  Status: ${order.status}${isOverdue ? ' (OVERDUE!)' : ''}`);
    console.log(`  Schedule enabled: ${order.schedule_enabled}`);
    if (order.schedule_enabled) {
      console.log(`  Session: ${order.session_time}`);
      console.log(`  Scheduled for: ${scheduledFor}`);
      console.log(`  Lock scheduled_time: ${lockTime}`);
      console.log(`  Locked: ${order.locked ? `Yes by ${order.locked_by} at ${order.locked_at ? new Date(order.locked_at).toISOString() : 'N/A'}` : 'No'}`);
    }
    if (order.last_error) {
      console.log(`  Last error: ${order.last_error}`);
    }
    console.log(`  Retry count: ${order.retry_count}/${order.max_retries}`);
    console.log(`  Created: ${new Date(order.created_at).toLocaleString('en-US', { timeZone: 'America/New_York' })}`);
    console.log(`  Updated: ${new Date(order.updated_at).toLocaleString('en-US', { timeZone: 'America/New_York' })}`);
    if (order.submitted_at) {
      console.log(`  Submitted at: ${new Date(order.submitted_at).toLocaleString('en-US', { timeZone: 'America/New_York' })}`);
    }
    if (order.etrade_order_id) {
      console.log(`  E*TRADE Order ID: ${order.etrade_order_id}`);
    }
    console.log('');
  }

  // Check executions for CRCA orders
  const executions = await query(`
    SELECT 
      oe.id,
      oe.order_id,
      oe.status,
      oe.error_message,
      oe.execution_time,
      oe.etrade_order_id,
      o.symbol,
      o.action,
      o.quantity
    FROM order_executions oe
    JOIN orders o ON oe.order_id = o.id
    WHERE o.symbol = 'CRCA'
    ORDER BY oe.execution_time DESC
  `);

  console.log(`\nCRCA order executions: ${executions.rows.length}\n`);
  for (const exec of executions.rows) {
    console.log(`Execution ID: ${exec.id}`);
    console.log(`  Order ID: ${exec.order_id} (${exec.symbol} ${exec.action} ${exec.quantity})`);
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

  // Check current time in EST
  const now = new Date();
  const estFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const estParts = estFormatter.formatToParts(now);
  const estDate = `${estParts.find((p) => p.type === 'year')?.value}-${estParts.find((p) => p.type === 'month')?.value}-${estParts.find((p) => p.type === 'day')?.value}`;
  const estTime = `${estParts.find((p) => p.type === 'hour')?.value}:${estParts.find((p) => p.type === 'minute')?.value}`;
  console.log(`\nCurrent time (EST): ${estDate} ${estTime}`);

  process.exit(0);
}

checkCRCAOrders().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
