import dotenv from 'dotenv';
import { query } from '../server/database/client.js';

dotenv.config();

async function checkStuckOrder() {
  const orderId = '7f6c30df-21cf-4e05-8bd3-707026041dbb';
  
  console.log(`Checking order ${orderId}...\n`);

  const order = await query(`
    SELECT 
      o.*,
      l.locked,
      l.locked_by,
      l.locked_at,
      l.scheduled_time
    FROM orders o
    LEFT JOIN scheduled_order_locks l ON o.id = l.order_id
    WHERE o.id = $1
  `, [orderId]);

  if (order.rows.length === 0) {
    console.log('Order not found');
    process.exit(1);
  }

  const o = order.rows[0];
  console.log('Order details:');
  console.log(`  ID: ${o.id}`);
  console.log(`  Symbol: ${o.symbol}`);
  console.log(`  Action: ${o.action} ${o.quantity} shares`);
  console.log(`  Status: ${o.status}`);
  console.log(`  Schedule enabled: ${o.schedule_enabled}`);
  console.log(`  Session: ${o.session_time}`);
  console.log(`  Scheduled for: ${o.scheduled_for ? new Date(o.scheduled_for).toLocaleString('en-US', { timeZone: 'America/New_York' }) : 'N/A'}`);
  console.log(`  Lock scheduled_time: ${o.scheduled_time ? new Date(o.scheduled_time).toLocaleString('en-US', { timeZone: 'America/New_York' }) : 'N/A'}`);
  console.log(`  Locked: ${o.locked ? `Yes by ${o.locked_by} at ${o.locked_at ? new Date(o.locked_at).toISOString() : 'N/A'}` : 'No'}`);
  console.log(`  Last error: ${o.last_error || 'None'}`);
  console.log(`  Retry count: ${o.retry_count}/${o.max_retries}`);
  console.log(`  Created: ${new Date(o.created_at).toLocaleString('en-US', { timeZone: 'America/New_York' })}`);
  console.log(`  Updated: ${new Date(o.updated_at).toLocaleString('en-US', { timeZone: 'America/New_York' })}`);
  console.log(`  Submitted at: ${o.submitted_at ? new Date(o.submitted_at).toLocaleString('en-US', { timeZone: 'America/New_York' }) : 'N/A'}`);

  // Check executions
  const executions = await query(`
    SELECT * FROM order_executions
    WHERE order_id = $1
    ORDER BY execution_time DESC
  `, [orderId]);

  console.log(`\nOrder executions: ${executions.rows.length}`);
  for (const exec of executions.rows) {
    console.log(`  ${exec.status} at ${new Date(exec.execution_time).toLocaleString('en-US', { timeZone: 'America/New_York' })}`);
    if (exec.error_message) {
      console.log(`    Error: ${exec.error_message}`);
    }
  }

  // Check if lock is expired (older than 5 minutes)
  if (o.locked && o.locked_at) {
    const lockAge = Date.now() - new Date(o.locked_at).getTime();
    const lockAgeMinutes = lockAge / 1000 / 60;
    console.log(`\nLock age: ${lockAgeMinutes.toFixed(2)} minutes`);
    if (lockAgeMinutes > 5) {
      console.log('⚠️  Lock is expired (>5 minutes old)');
      console.log('This order is stuck. The lock should be released.');
    }
  }

  process.exit(0);
}

checkStuckOrder().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
