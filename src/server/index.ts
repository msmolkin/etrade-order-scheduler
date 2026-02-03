import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import http from 'http';
import dotenv from 'dotenv';
import ordersRouter from './routes/orders.js';
import accountsRouter from './routes/accounts.js';
import positionsRouter from './routes/positions.js';
import positionsCushionsRouter from './routes/positions-cushions.js';
import authRouter from './routes/auth.js';
import { healthCheck } from './database/client.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

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

// Broadcast function for order updates
export function broadcastOrderUpdate(order: any) {
  const message = JSON.stringify({
    type: 'order_update',
    order,
    timestamp: new Date().toISOString(),
  });

  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      // OPEN
      client.send(message);
    }
  });
}

// Start server
server.listen(port, () => {
  console.log('\n🚀 E*TRADE Trade Placer Server');
  console.log('================================');
  console.log(`HTTP Server: http://localhost:${port}`);
  console.log(`WebSocket: ws://localhost:${port}/ws`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`E*TRADE Mode: ${process.env.ETRADE_SANDBOX === 'true' ? 'SANDBOX' : 'PRODUCTION'}`);
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
  console.log('\nPress Ctrl+C to stop\n');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n⏹️  Shutting down server...');
  server.close(() => {
    console.log('✓ Server stopped');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n⏹️  Shutting down server...');
  server.close(() => {
    console.log('✓ Server stopped');
    process.exit(0);
  });
});
