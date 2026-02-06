import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import http from 'http';
import dotenv from 'dotenv';
import { setBroadcast } from './ws-broadcast.js';
import ordersRouter from './routes/orders.js';
import accountsRouter from './routes/accounts.js';
import positionsRouter from './routes/positions.js';
import positionsCushionsRouter from './routes/positions-cushions.js';
import authRouter from './routes/auth.js';
import symbolsRouter from './routes/symbols.js';
import { healthCheck, runSchema } from './database/client.js';
import { ETradeClient } from './services/etrade-client.js';
import { OrderService } from './services/order-service.js';
import { OrderExecutor } from './services/order-executor.js';
import { ThresholdMonitor } from './services/threshold-monitor.js';
import { setGetThresholdMonitor } from './context.js';
import type { ETradeCredentials } from '../shared/types/index.js';

// Capture shell env before .env so "ETRADE_SANDBOX=false npm run dev" always uses production
const etradeSandboxFromShell = process.env.ETRADE_SANDBOX;
dotenv.config();
if (etradeSandboxFromShell !== undefined) {
  process.env.ETRADE_SANDBOX = etradeSandboxFromShell;
}

const app = express();
const port = process.env.PORT || 3001;

// Initialize services for threshold monitoring
let thresholdMonitor: ThresholdMonitor | null = null;

function getETradeClient(): ETradeClient {
  const isSandbox = process.env.ETRADE_SANDBOX === 'true';
  const credentials: ETradeCredentials = isSandbox
    ? {
        consumerKey: process.env.ETRADE_SANDBOX_KEY!,
        consumerSecret: process.env.ETRADE_SANDBOX_SECRET!,
        accessToken: process.env.ETRADE_SANDBOX_ACCESS_TOKEN,
        accessTokenSecret: process.env.ETRADE_SANDBOX_ACCESS_TOKEN_SECRET,
      }
    : {
        consumerKey: process.env.ETRADE_CONSUMER_KEY!,
        consumerSecret: process.env.ETRADE_CONSUMER_SECRET!,
        accessToken: process.env.ETRADE_ACCESS_TOKEN,
        accessTokenSecret: process.env.ETRADE_ACCESS_TOKEN_SECRET,
      };

  return new ETradeClient(credentials, isSandbox);
}

function initializeThresholdMonitor(): void {
  try {
    const etradeClient = getETradeClient();
    const orderService = new OrderService();
    const orderExecutor = new OrderExecutor(etradeClient, orderService);

    // Set callback to activate sell order monitoring after buy orders execute
    orderExecutor.setOnOrderFilledCallback(async (order) => {
      if (thresholdMonitor && order.action === 'BUY' && order.sellOrderEnabled) {
        await thresholdMonitor.activateSellOrderMonitoring(order.id);
      }
    });

    thresholdMonitor = new ThresholdMonitor(etradeClient, orderService, orderExecutor);

    // Start monitoring (will load active orders from database)
    thresholdMonitor.start().catch((error) => {
      console.error('[ThresholdMonitor] Failed to start:', error.message);
    });

    console.log('  Threshold Monitor: initialized');
  } catch (error: any) {
    console.error('  Threshold Monitor: failed to initialize -', error.message);
    console.error('  → Threshold orders will not be monitored until server restart');
  }
}

// Export threshold monitor for use in routes and register in context
export function getThresholdMonitor(): ThresholdMonitor | null {
  return thresholdMonitor;
}
setGetThresholdMonitor(getThresholdMonitor);

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', async (req, res) => {
  const dbHealthy = await healthCheck();
  res.json({
    status: dbHealthy ? 'healthy' : 'unhealthy',
    database: dbHealthy,
    timestamp: new Date().toISOString(),
  });
});

// Routes
app.use('/api/orders', ordersRouter);
app.use('/api/auth', authRouter);
app.use('/api/accounts', accountsRouter);
app.use('/api/positions', positionsRouter);
app.use('/api/positions/cushions', positionsCushionsRouter);
app.use('/api/symbols', symbolsRouter);

// Create HTTP server
const server = http.createServer(app);

// WebSocket server for real-time updates
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  console.log('✓ WebSocket client connected');

  ws.on('message', (message) => {
    console.log('Received:', message.toString());
  });

  ws.on('close', () => {
    console.log('✗ WebSocket client disconnected');
  });

  // Send initial connection message
  ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
});

setBroadcast((order) => {
  const message = JSON.stringify({
    type: 'order_update',
    order,
    timestamp: new Date().toISOString(),
  });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(message);
  });
});

// Start server
server.listen(port, async () => {
  console.log('\n🚀 E*TRADE Trade Placer Server');
  console.log('================================');
  console.log(`HTTP Server: http://localhost:${port}`);
  console.log(`WebSocket: ws://localhost:${port}/ws`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  const isSandbox = process.env.ETRADE_SANDBOX === 'true';
  console.log(
    `E*TRADE: ${isSandbox ? 'SANDBOX' : 'PRODUCTION'} (ETRADE_SANDBOX=${process.env.ETRADE_SANDBOX ?? 'unset'})`
  );
  if (isSandbox) {
    console.log('  → Using sandbox tokens. For production, set ETRADE_SANDBOX=false in .env or run with ETRADE_SANDBOX=false');
  }
  const schemaResult = await runSchema();
  if (schemaResult.ok) {
    console.log('  Database: schema applied (tables ready)');
  } else {
    const url = process.env.DATABASE_URL;
    let hostPort = 'host:port';
    if (url) {
      try {
        const u = new URL(url.replace(/^postgresql:\/\//, 'http://'));
        hostPort = `${u.hostname}:${u.port || '5432'}`;
      } catch (_) {}
    }
    console.log('  Database: schema not applied —', schemaResult.error);
    console.log('  → DATABASE_URL points to', hostPort + '. Is PostgreSQL running there?');
    if (hostPort.includes('5432')) {
      console.log('  → Homebrew postgresql@14 often uses port 5433. Try DATABASE_URL=...localhost:5433/yourdb');
    }
    console.log('  → DB operations will fail until fixed.');
  }

  // Initialize threshold monitor after database is ready
  initializeThresholdMonitor();

  console.log('\nEndpoints:');
  console.log('  GET    /health');
  console.log('  GET    /api/auth/status');
  console.log('  GET    /api/auth/start');
  console.log('  GET    /api/auth/callback');
  console.log('  POST   /api/auth/verify');
  console.log('  POST   /api/auth/auto');
  console.log('  GET    /api/accounts');
  console.log('  GET    /api/positions');
  console.log('  GET    /api/positions/cushions');
  console.log('  GET    /api/orders');
  console.log('  POST   /api/orders');
  console.log('  GET    /api/orders/:id');
  console.log('  PATCH  /api/orders/:id');
  console.log('  DELETE /api/orders/:id');
  console.log('  POST   /api/orders/:id/resend');
  console.log('  GET    /api/orders/expired');
  console.log('  GET    /api/orders/market/options-chain');
  console.log('  GET    /api/orders/market/quote');
  console.log('  GET    /api/symbols/search');
  console.log('\nPress Ctrl+C to stop\n');
});

// Graceful shutdown
async function shutdown() {
  console.log('\n⏹️  Shutting down server...');
  
  // Stop threshold monitor
  if (thresholdMonitor) {
    await thresholdMonitor.stop();
  }
  
  server.close(() => {
    console.log('✓ Server stopped');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
