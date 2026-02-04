import dotenv from 'dotenv';
import { query, transaction } from '../server/database/client.js';

dotenv.config();

async function fixStuckOrder() {
  const orderId = '7f6c30df-21cf-4e05-8bd3-707026041dbb';
  
  console.log(`Fixing stuck order ${orderId}...\n`);

  // First, check the order status
  const order = await query(`
    SELECT 
      o.*,
      l.locked,
      l.locked_by,
      l.locked_at
    FROM orders o
    LEFT JOIN scheduled_order_locks l ON o.id = l.order_id
    WHERE o.id = $1
  `, [orderId]);

  if (order.rows.length === 0) {
    console.log('Order not found');
    process.exit(1);
  }

  const o = order.rows[0];
  console.log(`Order status: ${o.status}`);
  console.log(`Locked: ${o.locked ? `Yes by ${o.locked_by}` : 'No'}`);
  
  if (o.locked && o.locked_at) {
    const lockAge = Date.now() - new Date(o.locked_at).getTime();
    const lockAgeMinutes = lockAge / 1000 / 60;
    console.log(`Lock age: ${lockAgeMinutes.toFixed(2)} minutes`);
  }

  // Release the lock and reset status to SCHEDULED so it can be retried
  await transaction(async (client) => {
    // Release the lock
    await client.query(`
      UPDATE scheduled_order_locks
      SET locked = false, locked_by = NULL, locked_at = NULL
      WHERE order_id = $1
    `, [orderId]);

    // Reset status to SCHEDULED if it's SUBMITTED
    if (o.status === 'SUBMITTED') {
      await client.query(`
        UPDATE orders
        SET status = 'SCHEDULED', submitted_at = NULL
        WHERE id = $1
      `, [orderId]);
      console.log('\n✓ Released lock and reset status to SCHEDULED');
      console.log('The order will be retried on the next scheduler run.');
    } else {
      console.log('\n✓ Released lock');
      console.log(`Order status remains: ${o.status}`);
    }
  });

  // Verify
  const updated = await query(`
    SELECT 
      o.status,
      l.locked
    FROM orders o
    LEFT JOIN scheduled_order_locks l ON o.id = l.order_id
    WHERE o.id = $1
  `, [orderId]);

  console.log(`\nUpdated order status: ${updated.rows[0].status}`);
  console.log(`Lock released: ${!updated.rows[0].locked ? 'Yes' : 'No'}`);

  process.exit(0);
}

fixStuckOrder().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
