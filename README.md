# E*TRADE Trade Placer

An automated daily trading application that places trades on E*TRADE with hybrid scheduling (local + AWS Lambda) and smart order management.

## Features

- **Hybrid Scheduler**: Runs both locally and on AWS Lambda for redundancy
- **Daily Order Placement**: Automatically converts GTC orders to DAY orders and re-places them daily
- **Options Chain Viewer**: Real-time options data visualization
- **Order Management**: View, create, and manage orders with scheduling
- **Expired Order Resend**: Easily resend expired orders with one click
- **Real-time Updates**: WebSocket integration for live order status
- **Distributed Locking**: Prevents duplicate order placement
- **Retry Logic**: Automatic retry with configurable max attempts

## Architecture

```
┌─────────────────────┐
│  React Frontend     │
│  (Vite + Tailwind)  │
└──────────┬──────────┘
           │ HTTP/WebSocket
┌──────────┴──────────┐
│  Express Server     │
│  - REST API         │
│  - WebSocket Server │
└──────────┬──────────┘
           │
┌──────────┴──────────┐
│  E*TRADE API        │
│  - OAuth 1.0a       │
│  - Order Placement  │
│  - Options Data     │
└─────────────────────┘

Schedulers (Hybrid):
┌──────────────────┐    ┌─────────────────┐
│ Local Scheduler  │    │ Lambda Scheduler│
│ (node-cron)      │    │ (EventBridge)   │
└────────┬─────────┘    └────────┬────────┘
         │                       │
         └───────────┬───────────┘
                     │
         ┌───────────┴──────────┐
         │  PostgreSQL DB       │
         │  - Orders            │
         │  - Locks             │
         │  - Execution History │
         └──────────────────────┘
```

## Prerequisites

- Node.js 24+
- PostgreSQL 14+
- Redis (optional, for distributed locking)
- E*TRADE API credentials ([Get them here](https://developer.etrade.com))
- AWS Account (for Lambda deployment)

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Up Database

```bash
# Create PostgreSQL database
createdb etrade_trader

# Copy environment file
cp .env.example .env

# Edit .env with your credentials
# DATABASE_URL=postgresql://user:password@localhost:5432/etrade_trader
# ETRADE_CONSUMER_KEY=your_key
# ETRADE_CONSUMER_SECRET=your_secret
# ...

# Run migrations
npm run db:migrate
```

### 3. E*TRADE OAuth Setup

You need to obtain OAuth access tokens from E*TRADE:

1. Go to [E*TRADE Developer Portal](https://developer.etrade.com)
2. Create an application and get your Consumer Key and Secret
3. Use the OAuth flow to get Access Token and Access Token Secret
4. Add these to your `.env` file:

```bash
ETRADE_CONSUMER_KEY=your_consumer_key
ETRADE_CONSUMER_SECRET=your_consumer_secret
ETRADE_ACCESS_TOKEN=your_access_token
ETRADE_ACCESS_TOKEN_SECRET=your_access_token_secret
ETRADE_SANDBOX=true  # Set to false for production
```

### 4. Run Development Server

```bash
# Run both frontend and backend
npm run dev

# Or run separately:
npm run server:dev  # Backend on port 3001
npm run client:dev  # Frontend on port 3000
```

### 5. Run Local Scheduler

```bash
npm run scheduler:local
```

The scheduler will automatically place orders at:
- **9:30 AM EST** - Market open orders
- **7:00 AM EST** - Extended hours orders

## Order Duration Conversion

The app handles orders that can only be placed as DAY orders but you want to maintain as GTC:

1. **Preferred Duration**: What you want (e.g., GTC)
2. **Actual Duration**: What gets placed (e.g., DAY)
3. **Requires Daily**: `true` if they differ

When `requiresDaily = true`, the scheduler will:
- Place the order daily at the specified time
- Check if it was filled
- If not filled, create a new order for the next trading day
- Track execution history

## Usage

### Creating an Order

1. Go to **Create Order** tab
2. Fill in order details:
   - Account ID (from E*TRADE)
   - Symbol
   - Action (BUY, SELL, etc.)
   - Quantity, prices
   - **Preferred Duration**: GTC (what you want)
   - **Actual Duration**: DAY (what gets placed)
   - **Session Time**: MARKET (9:30 AM) or EXTENDED (7:00 AM)
3. Enable scheduling and set the time
4. Click **Create Order**

### Viewing Active Orders

The **Active Orders** tab shows all orders with:
- Real-time status updates via WebSocket
- Filter by status (SCHEDULED, PENDING, SUBMITTED, etc.)
- Delete orders
- See retry attempts and errors

### Resending Expired Orders

1. Go to **Expired Orders** tab
2. Find the expired order
3. Click **Resend**
4. Confirm to create a new identical order

### Options Chain

1. Go to **Options Chain** tab
2. Enter a symbol (e.g., AAPL)
3. Optionally select an expiration date
4. View calls and puts with pricing data

## AWS Lambda Deployment

### 1. Build Lambda Package

```bash
npm run lambda:build
```

### 2. Create Lambda Function

```bash
aws lambda create-function \
  --function-name etrade-scheduler \
  --runtime nodejs24.x \
  --role arn:aws:iam::YOUR_ACCOUNT:role/lambda-execution-role \
  --handler lambda-scheduler.handler \
  --zip-file fileb://dist/lambda.zip \
  --environment Variables="{
    DATABASE_URL=your_postgres_url,
    ETRADE_CONSUMER_KEY=your_key,
    ETRADE_CONSUMER_SECRET=your_secret,
    ETRADE_ACCESS_TOKEN=your_token,
    ETRADE_ACCESS_TOKEN_SECRET=your_token_secret
  }"
```

### 3. Set Up EventBridge Rules

```bash
# Market open (9:30 AM EST, Mon-Fri)
aws events put-rule \
  --name etrade-market-open \
  --schedule-expression "cron(30 9 ? * MON-FRI *)" \
  --state ENABLED

aws events put-targets \
  --rule etrade-market-open \
  --targets "Id=1,Arn=arn:aws:lambda:REGION:ACCOUNT:function:etrade-scheduler,Input={\"sessionTime\":\"MARKET\"}"

# Extended hours (7:00 AM EST, Mon-Fri)
aws events put-rule \
  --name etrade-extended-hours \
  --schedule-expression "cron(0 7 ? * MON-FRI *)" \
  --state ENABLED

aws events put-targets \
  --rule etrade-extended-hours \
  --targets "Id=1,Arn=arn:aws:lambda:REGION:ACCOUNT:function:etrade-scheduler,Input={\"sessionTime\":\"EXTENDED\"}"
```

## Database Schema

### Orders Table
- `id`: UUID primary key
- `symbol`, `quantity`, `action`, `order_type`
- `preferred_duration`, `actual_duration`, `requires_daily`
- `session_time`: MARKET or EXTENDED
- `scheduled_for`: When to place the order
- `status`: PENDING, SCHEDULED, SUBMITTED, FILLED, etc.
- `retry_count`, `max_retries`
- `etrade_order_id`: E*TRADE's order ID

### Scheduled Order Locks
- `order_id`: Foreign key to orders
- `locked`, `locked_by`, `locked_at`
- Prevents duplicate execution

### Order Executions
- Historical log of all execution attempts
- Status, errors, filled quantity, average price

## API Endpoints

### Orders
- `GET /api/orders` - List all orders
- `POST /api/orders` - Create new order
- `GET /api/orders/:id` - Get order details
- `PATCH /api/orders/:id` - Update order
- `DELETE /api/orders/:id` - Delete order
- `POST /api/orders/:id/resend` - Resend expired order
- `GET /api/orders/expired` - Get expired orders

### Market Data
- `GET /api/orders/market/options-chain?symbol=AAPL` - Get options chain
- `GET /api/orders/market/quote?symbols=AAPL,MSFT` - Get quotes

#### Quote Response Structure

The E*TRADE quote API returns data in a nested structure. Market data fields are located inside an `All` object:

```json
{
  "dateTime": "13:38:49 EST 02-04-2026",
  "quoteStatus": "REALTIME",
  "All": {
    "bid": 233.01,
    "ask": 233.03,
    "bidSize": 100,
    "askSize": 100,
    "lastTrade": 233.02,
    "totalVolume": 27046356,
    "changeClose": -5.6,
    "changeClosePercentage": -2.35,
    "high": 238.86,
    "low": 231.97,
    "open": 238.86,
    "previousClose": 238.62
  }
}
```

**Important field name mappings:**
- `lastTrade` → last price (not `last`)
- `totalVolume` → volume (not `volume`)
- `changeClose` → change amount (not `change`)
- `changeClosePercentage` → change percentage (not `changePct`)
- `previousClose` → close price (not `close`)

When accessing quote data in your code:
```typescript
const quotes = await client.getQuote(['AMZN']);
const quoteData = quotes[0].All || quotes[0]; // Fallback for compatibility
const bid = quoteData.bid;
const ask = quoteData.ask;
const lastPrice = quoteData.lastTrade || quoteData.previousClose;
```

### Health
- `GET /health` - Server and database health check

## WebSocket Events

Connect to `ws://localhost:3001/ws`

### Client → Server
```json
{
  "type": "ping"
}
```

### Server → Client
```json
{
  "type": "order_update",
  "order": { ... },
  "timestamp": "2026-01-21T10:00:00.000Z"
}
```

## Security Considerations

1. **Never commit `.env`** - Contains sensitive API credentials
2. **Use E*TRADE Sandbox** for testing
3. **Set up IAM roles** properly for Lambda
4. **Enable HTTPS** in production
5. **Implement authentication** for the web interface
6. **Use Redis** for production distributed locking

## Troubleshooting

### Orders Not Executing
- Check scheduler logs: `npm run scheduler:local`
- Verify E*TRADE credentials are valid
- Check order status in the database
- Look for errors in `last_error` field

### Database Connection Issues
- Verify PostgreSQL is running
- Check `DATABASE_URL` in `.env`
- Test connection: `psql $DATABASE_URL`

### WebSocket Not Connecting
- Ensure backend is running on port 3001
- Check browser console for errors
- Verify firewall settings

## Production Deployment

1. **Database**: Use managed PostgreSQL (AWS RDS, Heroku Postgres)
2. **Backend**: Deploy to AWS ECS, Heroku, or DigitalOcean
3. **Frontend**: Deploy to Vercel, Netlify, or CloudFront
4. **Scheduler**: Use both local (on server) and Lambda for redundancy
5. **Monitoring**: Set up CloudWatch alarms for failed executions
6. **Backup**: Regular database backups

## License

MIT

## Disclaimer

This software is for educational purposes. Use at your own risk. The author is not responsible for any financial losses incurred through the use of this software. Always test thoroughly with E*TRADE's sandbox environment before using real money.
