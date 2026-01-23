import { Router } from 'express';
import { OrderService } from '../services/order-service.js';
import { ETradeClient } from '../services/etrade-client.js';
import { OrderExecutor } from '../services/order-executor.js';
import type { Order } from '../../shared/types/index.js';

const router = Router();
const orderService = new OrderService();

// Create E*TRADE client (will be initialized with OAuth tokens from session)
function getETradeClient(): ETradeClient {
  const isSandbox = process.env.ETRADE_SANDBOX === 'true';

  // Use sandbox-specific keys and tokens when in sandbox mode
  const consumerKey = isSandbox
    ? process.env.ETRADE_SANDBOX_KEY!
    : process.env.ETRADE_CONSUMER_KEY!;
  const consumerSecret = isSandbox
    ? process.env.ETRADE_SANDBOX_SECRET!
    : process.env.ETRADE_CONSUMER_SECRET!;
  const accessToken = isSandbox
    ? process.env.ETRADE_SANDBOX_ACCESS_TOKEN
    : process.env.ETRADE_ACCESS_TOKEN;
  const accessTokenSecret = isSandbox
    ? process.env.ETRADE_SANDBOX_ACCESS_TOKEN_SECRET
    : process.env.ETRADE_ACCESS_TOKEN_SECRET;

  return new ETradeClient(
    {
      consumerKey,
      consumerSecret,
      accessToken,
      accessTokenSecret,
    },
    isSandbox
  );
}

// Get all orders
router.get('/', async (req, res) => {
  try {
    const { accountId, status, scheduleEnabled, limit } = req.query;

    const orders = await orderService.getOrders({
      accountId: accountId as string,
      status: status as any,
      scheduleEnabled: scheduleEnabled === 'true',
      limit: limit ? parseInt(limit as string) : undefined,
    });

    res.json(orders);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get expired orders
router.get('/expired', async (req, res) => {
  try {
    const { limit } = req.query;
    const orders = await orderService.getExpiredOrders(
      limit ? parseInt(limit as string) : 50
    );
    res.json(orders);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get single order
router.get('/:id', async (req, res) => {
  try {
    const order = await orderService.getOrder(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json(order);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Create new order
router.post('/', async (req, res) => {
  try {
    const orderData = req.body as Omit<Order, 'id' | 'createdAt' | 'updatedAt'>;

    // Determine if order requires daily placement
    const requiresDaily = orderData.preferredDuration !== orderData.actualDuration;

    const order = await orderService.createOrder({
      ...orderData,
      requiresDaily,
      status: orderData.scheduleEnabled ? 'SCHEDULED' : 'PENDING',
      retryCount: 0,
      maxRetries: orderData.maxRetries || 3,
    });

    res.status(201).json(order);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Resend expired order
router.post('/:id/resend', async (req, res) => {
  try {
    const existingOrder = await orderService.getOrder(req.params.id);
    if (!existingOrder) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Create a new order based on the expired one
    const newOrder = await orderService.createOrder({
      ...existingOrder,
      id: undefined as any,
      status: existingOrder.scheduleEnabled ? 'SCHEDULED' : 'PENDING',
      etradeOrderId: undefined,
      submittedAt: undefined,
      filledAt: undefined,
      cancelledAt: undefined,
      expiresAt: undefined,
      lastError: undefined,
      retryCount: 0,
    });

    res.status(201).json(newOrder);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Submit order immediately to E*TRADE
router.post('/:id/submit', async (req, res) => {
  try {
    const order = await orderService.getOrder(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Validate order is in a submittable state
    if (order.status !== 'PENDING' && order.status !== 'SCHEDULED') {
      return res.status(400).json({
        error: `Order is ${order.status}, must be PENDING or SCHEDULED to submit`,
      });
    }

    // Execute order immediately using OrderExecutor
    const client = getETradeClient();
    const executor = new OrderExecutor(client, orderService);
    const lockerId = `manual-submit-${Date.now()}`;

    const success = await executor.executeOrder(order, lockerId);

    // Return updated order
    const updatedOrder = await orderService.getOrder(req.params.id);
    res.json({ success, order: updatedOrder });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update order
router.patch('/:id', async (req, res) => {
  try {
    const { status, ...details } = req.body;

    if (status) {
      await orderService.updateOrderStatus(req.params.id, status, details);
    }

    const order = await orderService.getOrder(req.params.id);
    res.json(order);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Delete order
router.delete('/:id', async (req, res) => {
  try {
    await orderService.deleteOrder(req.params.id);
    res.status(204).send();
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get options chain
router.get('/market/options-chain', async (req, res) => {
  try {
    const { symbol, expirationDate } = req.query;

    if (!symbol) {
      return res.status(400).json({ error: 'Symbol is required' });
    }

    const client = getETradeClient();
    const optionsChain = await client.getOptionsChain(
      symbol as string,
      expirationDate as string
    );

    res.json(optionsChain);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Test order placement (debug endpoint)
router.post('/test-place', async (req, res) => {
  try {
    const client = getETradeClient();
    console.log('Testing order placement from server...');

    const result = await client.placeOrder({
      accountIdKey: '[REDACTED]',
      symbol: 'AAPL',
      orderAction: 'BUY',
      clientOrderId: 'test-' + Date.now(),
      priceType: 'LIMIT',
      quantity: 1,
      orderTerm: 'GOOD_FOR_DAY',
      marketSession: 'REGULAR',
      limitPrice: 150,
    });

    res.json({ success: true, result });
  } catch (error: any) {
    console.error('Test place error:', error.response?.status, error.response?.data);
    res.status(500).json({
      success: false,
      error: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
  }
});

// Get quote
router.get('/market/quote', async (req, res) => {
  try {
    const { symbols } = req.query;

    if (!symbols) {
      return res.status(400).json({ error: 'Symbols are required' });
    }

    const symbolArray = (symbols as string).split(',');
    const client = getETradeClient();
    const quotes = await client.getQuote(symbolArray);

    res.json(quotes);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
