import dotenv from 'dotenv';
import { query } from '../server/database/client.js';
import { OrderService } from '../server/services/order-service.js';

dotenv.config();

const IN_ONE_MINUTE = new Date(Date.now() + 60 * 1000);
const IN_TEN_MINUTES = new Date(Date.now() + 10 * 60 * 1000);
const EXPIRATION_2026_02_06 = new Date(Date.UTC(2026, 1, 6, 12, 0, 0, 0)); // Feb 6, 2026

async function scheduleIntcOptionOrders() {
  const orderService = new OrderService();

  const accountRow = await query<{ account_id: string }>(
    'SELECT account_id FROM orders LIMIT 1'
  );
  if (accountRow.rows.length === 0) {
    console.log('No existing orders; need account_id. Add it to the script or create an order first.');
    process.exit(1);
  }
  const accountId = accountRow.rows[0].account_id;

  const baseOrder = {
    accountId,
    symbol: 'INTC',
    securityType: 'OPTION' as const,
    optionType: 'CALL' as const,
    strikePrice: 50,
    expirationDate: EXPIRATION_2026_02_06,
    orderType: 'LIMIT' as const,
    quantity: 1,
    preferredDuration: 'DAY' as const,
    actualDuration: 'DAY' as const,
    requiresDaily: false,
    sessionTime: 'MARKET' as const,
    scheduleEnabled: true,
    scheduleFrequency: 'DAILY' as const,
    scheduleOnce: true,
    status: 'SCHEDULED' as const,
    retryCount: 0,
    maxRetries: 3,
  };

  const order1 = await orderService.createOrder({
    ...baseOrder,
    action: 'BUY_TO_COVER',
    limitPrice: 0.54,
    scheduledFor: IN_ONE_MINUTE,
    notes: 'INTC 2/6/26 $50 Call buy back @ 0.54 (scheduled in 1 min)',
  });

  const order2 = await orderService.createOrder({
    ...baseOrder,
    action: 'BUY',
    limitPrice: 0.36,
    scheduledFor: IN_TEN_MINUTES,
    notes: 'INTC 2/6/26 $50 Call purchase @ 0.36 (scheduled in 10 min)',
  });

  console.log('Scheduled two INTC option orders:');
  console.log(`  1. BUY_TO_COVER (buy back) @ $0.54 – due ${IN_ONE_MINUTE.toLocaleString()}`);
  console.log(`     Order ID: ${order1.id}`);
  console.log(`  2. BUY (open) @ $0.36 – due ${IN_TEN_MINUTES.toLocaleString()}`);
  console.log(`     Order ID: ${order2.id}`);
  console.log('\nEnsure the server scheduler is running (due-orders check every 30s).');
  process.exit(0);
}

scheduleIntcOptionOrders().catch((err) => {
  console.error(err);
  process.exit(1);
});
