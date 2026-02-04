import dotenv from 'dotenv';
import { query } from '../server/database/client.js';

dotenv.config();

async function checkMissedOrders() {
  console.log('Checking for missed orders...\n');

  // Get current time in EST
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
  console.log(`Current time (EST): ${estDate} ${estTime}\n`);

  // Find orders that are SCHEDULED and should have been executed today
  const scheduledOrders = await query(`
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
      l.scheduled_time,
      l.locked,
      l.locked_by,
      l.locked_at
    FROM orders o
    LEFT JOIN scheduled_order_locks l ON o.id = l.order_id
    WHERE o.schedule_enabled = true
    AND o.status = 'SCHEDULED'
    AND DATE(o.scheduled_for AT TIME ZONE 'America/New_York') = CURRENT_DATE AT TIME ZONE 'America/New_York'
    ORDER BY o.scheduled_for ASC
  `);

  console.log(`Found ${scheduledOrders.rows.length} scheduled orders for today:\n`);

  for (const order of scheduledOrders.rows) {
    const scheduledTime = order.scheduled_time
      ? new Date(order.scheduled_time).toLocaleString('en-US', { timeZone: 'America/New_York' })
      : 'N/A';
    const scheduledFor = order.scheduled_for
      ? new Date(order.scheduled_for).toLocaleString('en-US', { timeZone: 'America/New_York' })
      : 'N/A';

    console.log(`Order ID: ${order.id}`);
    console.log(`  Symbol: ${order.symbol}`);
    console.log(`  Action: ${order.action} ${order.quantity} shares`);
    console.log(`  Status: ${order.status}`);
    console.log(`  Session: ${order.session_time}`);
    console.log(`  Scheduled for: ${scheduledFor}`);
    console.log(`  Lock scheduled_time: ${scheduledTime}`);
    console.log(`  Lock status: ${order.locked ? `LOCKED by ${order.locked_by} at ${order.locked_at ? new Date(order.locked_at).toISOString() : 'N/A'}` : 'UNLOCKED'}`);
    if (order.last_error) {
      console.log(`  Last error: ${order.last_error}`);
    }
    console.log(`  Retry count: ${order.retry_count}/${order.max_retries}`);
    console.log('');
  }

  // Check order_executions for today
  const executions = await query(`
    SELECT 
      oe.order_id,
      oe.status,
      oe.error_message,
      oe.execution_time,
      o.symbol,
      o.session_time
    FROM order_executions oe
    JOIN orders o ON oe.order_id = o.id
    WHERE DATE(oe.execution_time AT TIME ZONE 'America/New_York') = CURRENT_DATE AT TIME ZONE 'America/New_York'
    ORDER BY oe.execution_time DESC
  `);

  console.log(`\nOrder executions today: ${executions.rows.length}\n`);
  for (const exec of executions.rows) {
    console.log(`Order ${exec.order_id} (${exec.symbol}, ${exec.session_time})`);
    console.log(`  Status: ${exec.status}`);
    console.log(`  Time: ${new Date(exec.execution_time).toLocaleString('en-US', { timeZone: 'America/New_York' })}`);
    if (exec.error_message) {
      console.log(`  Error: ${exec.error_message}`);
    }
    console.log('');
  }

  // Check for orders that were scheduled for 7:00 AM today but weren't executed
  const sevenAMToday = new Date();
  const tz = 'America/New_York';
  const sevenAM = new Date(
    new Date().toLocaleString('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
  );
  sevenAM.setHours(7, 0, 0, 0);
  const sevenAMUTC = new Date(sevenAM.toLocaleString('en-US', { timeZone: 'UTC' }));

  const missed7AM = await query(`
    SELECT 
      o.id,
      o.symbol,
      o.action,
      o.quantity,
      o.status,
      l.scheduled_time,
      l.locked,
      l.locked_by
    FROM orders o
    INNER JOIN scheduled_order_locks l ON o.id = l.order_id
    WHERE o.schedule_enabled = true
    AND o.status = 'SCHEDULED'
    AND l.session_time = 'EXTENDED'
    AND DATE(l.scheduled_time AT TIME ZONE 'America/New_York') = CURRENT_DATE AT TIME ZONE 'America/New_York'
    AND EXTRACT(HOUR FROM l.scheduled_time AT TIME ZONE 'America/New_York') = 7
    AND EXTRACT(MINUTE FROM l.scheduled_time AT TIME ZONE 'America/New_York') = 0
  `);

  console.log(`\nOrders scheduled for 7:00 AM EST today: ${missed7AM.rows.length}\n`);
  for (const order of missed7AM.rows) {
    console.log(`Order ${order.id} (${order.symbol}): ${order.action} ${order.quantity}`);
    console.log(`  Status: ${order.status}`);
    console.log(`  Scheduled time: ${new Date(order.scheduled_time).toLocaleString('en-US', { timeZone: 'America/New_York' })}`);
    console.log(`  Locked: ${order.locked ? `Yes by ${order.locked_by}` : 'No'}`);
    console.log('');
  }

  process.exit(0);
}

checkMissedOrders().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
