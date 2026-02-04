import dotenv from 'dotenv';
import { query, transaction } from '../server/database/client.js';
import { OrderService } from '../server/services/order-service.js';
import { OrderExecutor } from '../server/services/order-executor.js';
import { ETradeClient } from '../server/services/etrade-client.js';

dotenv.config();

async function sendCRCAOrderNow() {
  console.log('Finding CRCA order...\n');

  const orderResult = await query(`
    SELECT o.* FROM orders o
    WHERE o.symbol = 'CRCA'
    AND o.schedule_enabled = true
    AND o.status = 'SCHEDULED'
    ORDER BY o.created_at DESC
    LIMIT 1
  `);

  if (orderResult.rows.length === 0) {
    console.log('No SCHEDULED CRCA order found');
    process.exit(1);
  }

  const orderRow = orderResult.rows[0];
  console.log(`Found order: ${orderRow.id}`);
  console.log(`  Symbol: ${orderRow.symbol}`);
  console.log(`  Action: ${orderRow.action} ${orderRow.quantity} shares`);
  console.log(`  Status: ${orderRow.status}`);
  console.log(`  Scheduled for: ${orderRow.scheduled_for ? new Date(orderRow.scheduled_for).toLocaleString('en-US', { timeZone: 'America/New_York' }) : 'N/A'}`);
  console.log('');

  // Map row to Order type
  const order = {
    id: orderRow.id,
    accountId: orderRow.account_id,
    symbol: orderRow.symbol,
    securityType: orderRow.security_type,
    optionSymbol: orderRow.option_symbol,
    optionType: orderRow.option_type,
    strikePrice: orderRow.strike_price ? parseFloat(orderRow.strike_price) : undefined,
    expirationDate: orderRow.expiration_date,
    action: orderRow.action,
    orderType: orderRow.order_type,
    quantity: orderRow.quantity,
    limitPrice: orderRow.limit_price ? parseFloat(orderRow.limit_price) : undefined,
    stopPrice: orderRow.stop_price ? parseFloat(orderRow.stop_price) : undefined,
    preferredDuration: orderRow.preferred_duration,
    actualDuration: orderRow.actual_duration,
    requiresDaily: orderRow.requires_daily,
    sessionTime: orderRow.session_time,
    scheduledFor: orderRow.scheduled_for,
    scheduleEnabled: orderRow.schedule_enabled,
    status: orderRow.status,
    etradeOrderId: orderRow.etrade_order_id,
    submittedAt: orderRow.submitted_at,
    filledAt: orderRow.filled_at,
    cancelledAt: orderRow.cancelled_at,
    expiresAt: orderRow.expires_at,
    lastError: orderRow.last_error,
    retryCount: orderRow.retry_count,
    maxRetries: orderRow.max_retries,
    createdAt: orderRow.created_at,
    updatedAt: orderRow.updated_at,
    notes: orderRow.notes,
  };

  // Initialize services
  const orderService = new OrderService();
  const etradeClient = new ETradeClient(
    {
      consumerKey: process.env.ETRADE_CONSUMER_KEY!,
      consumerSecret: process.env.ETRADE_CONSUMER_SECRET!,
      accessToken: process.env.ETRADE_ACCESS_TOKEN,
      accessTokenSecret: process.env.ETRADE_ACCESS_TOKEN_SECRET,
    },
    process.env.ETRADE_SANDBOX === 'true'
  );
  const orderExecutor = new OrderExecutor(etradeClient, orderService);

  console.log('Executing order now...\n');
  const schedulerId = 'manual-execution-' + Date.now();
  const success = await orderExecutor.executeOrder(order, schedulerId);

  if (success) {
    console.log('\n✓ Order executed successfully!');
  } else {
    console.log('\n✗ Order execution failed. Check the error messages above.');
  }

  process.exit(success ? 0 : 1);
}

sendCRCAOrderNow().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
