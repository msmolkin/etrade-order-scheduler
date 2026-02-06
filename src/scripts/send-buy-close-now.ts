import dotenv from 'dotenv';
import { query } from '../server/database/client.js';
import { OrderService } from '../server/services/order-service.js';
import { OrderExecutor } from '../server/services/order-executor.js';
import { ETradeClient } from '../server/services/etrade-client.js';

dotenv.config();

const LIMIT_PRICE = 0.05;

async function sendBuyCloseNow() {
  const orderService = new OrderService();

  const r = await query<{ id: string }>(
    `SELECT id FROM orders
     WHERE security_type = 'OPTION' AND action = 'BUY_TO_COVER'
     ORDER BY created_at DESC LIMIT 1`
  );

  if (r.rows.length === 0) {
    console.log('No OPTION BUY_TO_COVER order found.');
    process.exit(1);
  }

  const orderId = r.rows[0].id;

  await query(
    `UPDATE orders SET limit_price = $2, status = 'SCHEDULED', retry_count = 0, last_error = NULL WHERE id = $1`,
    [orderId, LIMIT_PRICE]
  );

  const order = await orderService.getOrder(orderId);
  if (!order) {
    console.log('Order not found after update.');
    process.exit(1);
  }

  console.log(`Sending BUY_CLOSE order ${orderId} (${order.symbol}) @ $${LIMIT_PRICE}...\n`);

  const isSandbox = process.env.ETRADE_SANDBOX === 'true';
  const etradeClient = new ETradeClient(
    {
      consumerKey: isSandbox ? process.env.ETRADE_SANDBOX_KEY! : process.env.ETRADE_CONSUMER_KEY!,
      consumerSecret: isSandbox ? process.env.ETRADE_SANDBOX_SECRET! : process.env.ETRADE_CONSUMER_SECRET!,
      accessToken: isSandbox ? process.env.ETRADE_SANDBOX_ACCESS_TOKEN : process.env.ETRADE_ACCESS_TOKEN,
      accessTokenSecret: isSandbox ? process.env.ETRADE_SANDBOX_ACCESS_TOKEN_SECRET : process.env.ETRADE_ACCESS_TOKEN_SECRET,
    },
    isSandbox
  );
  const executor = new OrderExecutor(etradeClient, orderService);
  const lockerId = 'buy-close-' + Date.now();

  const success = await executor.executeOrder(order, lockerId);

  if (success) {
    console.log('\n✓ Order placed successfully.');
  } else {
    console.log('\n✗ Order placement failed. Check lastError on the order.');
  }

  process.exit(success ? 0 : 1);
}

sendBuyCloseNow().catch((err) => {
  console.error(err);
  process.exit(1);
});
