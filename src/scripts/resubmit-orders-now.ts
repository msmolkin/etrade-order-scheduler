import dotenv from 'dotenv';
import { OrderService } from '../server/services/order-service.js';
import { OrderExecutor } from '../server/services/order-executor.js';
import { ETradeClient } from '../server/services/etrade-client.js';

dotenv.config();

async function resubmitOrdersNow() {
  const orderService = new OrderService();
  const orders = await orderService.getOrders({
    status: 'SCHEDULED',
    limit: 10,
  });

  const submittable = orders.filter(
    (o) => o.status === 'SCHEDULED' && (o.retryCount ?? 0) < (o.maxRetries ?? 3)
  );

  if (submittable.length === 0) {
    console.log('No SCHEDULED orders to resubmit.');
    process.exit(0);
  }

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

  const lockerId = 'resubmit-' + Date.now();
  for (const order of submittable) {
    console.log(`Submitting order ${order.id} (${order.symbol} ${order.action} ${order.quantity})...`);
    const success = await executor.executeOrder(order, lockerId);
    if (success) {
      console.log(`✓ Order ${order.id} placed successfully.`);
    } else {
      console.log(`✗ Order ${order.id} failed. Check lastError on the order.`);
    }
  }

  process.exit(0);
}

resubmitOrdersNow().catch((err) => {
  console.error(err);
  process.exit(1);
});
