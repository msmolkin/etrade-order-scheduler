# Quick Setup Guide

## Step-by-Step Setup

### 1. Install PostgreSQL (if not installed)

**macOS (Homebrew):**
```bash
brew install postgresql@14
brew services start postgresql@14
```

**Ubuntu/Debian:**
```bash
sudo apt-get install postgresql postgresql-contrib
sudo systemctl start postgresql
```

### 2. Create Database

```bash
# Create database user (if needed)
createuser -s etrade_user

# Create database
createdb etrade_trader
```

### 3. Configure Environment

```bash
# Copy example environment file
cp .env.example .env

# Edit .env with your settings
nano .env  # or use your preferred editor
```

**Required settings in `.env`:**
```bash
# Database
DATABASE_URL=postgresql://etrade_user@localhost:5432/etrade_trader

# E*TRADE API (Get from https://developer.etrade.com)
ETRADE_CONSUMER_KEY=your_consumer_key_here
ETRADE_CONSUMER_SECRET=your_consumer_secret_here
ETRADE_SANDBOX=true  # Use true for testing!

# Server
PORT=3001
NODE_ENV=development

# You'll add these after OAuth flow:
# ETRADE_ACCESS_TOKEN=
# ETRADE_ACCESS_TOKEN_SECRET=
```

### 4. Run Database Migrations

```bash
npm run db:migrate
```

You should see:
```
✓ Database migration completed successfully
```

### 5. Get E*TRADE Access Tokens

**Important**: You need to complete the OAuth flow to get access tokens.

1. Go to https://developer.etrade.com
2. Sign in and create an application
3. Get your Consumer Key and Consumer Secret
4. Follow E*TRADE's OAuth documentation to get Access Token and Access Token Secret
5. Add them to your `.env` file

### 6. Start the Application

**Option A: Run everything together**
```bash
npm run dev
```

**Option B: Run services separately** (recommended for debugging)

Terminal 1 - Backend:
```bash
npm run server:dev
```

Terminal 2 - Frontend:
```bash
npm run client:dev
```

Terminal 3 - Scheduler:
```bash
npm run scheduler:local
```

### 7. Access the Application

Open your browser to:
- **Frontend**: http://localhost:3000
- **API**: http://localhost:3001/health

## Testing Your Setup

### 1. Check Health
```bash
curl http://localhost:3001/health
```

Expected response:
```json
{
  "status": "healthy",
  "database": true,
  "timestamp": "2026-01-21T..."
}
```

### 2. Create a Test Order

Go to http://localhost:3000 and:
1. Click "Create Order"
2. Fill in:
   - Account ID: Your E*TRADE account ID
   - Symbol: AAPL (or any symbol)
   - Action: BUY
   - Quantity: 1
   - Preferred Duration: GTC
   - Actual Duration: DAY
   - Session Time: MARKET
3. Enable scheduling
4. Click "Create Order"

### 3. View the Order

Click "Active Orders" tab to see your scheduled order.

## Common Issues

### "Connection refused" error
- Make sure PostgreSQL is running: `pg_isready`
- Check DATABASE_URL in .env

### "OAuth token invalid"
- You need to complete the E*TRADE OAuth flow
- Make sure ETRADE_ACCESS_TOKEN and ETRADE_ACCESS_TOKEN_SECRET are set

### Port already in use
- Change PORT in .env to a different port
- Or kill the process: `lsof -ti:3001 | xargs kill`

### Database migration fails
- Make sure database exists: `psql -l | grep etrade_trader`
- Check database permissions
- Try: `dropdb etrade_trader && createdb etrade_trader && npm run db:migrate`

## Next Steps

1. **Test with E*TRADE Sandbox**: Keep `ETRADE_SANDBOX=true` for all testing
2. **Create some orders**: Test the complete flow
3. **Deploy to AWS Lambda**: Follow README.md for Lambda setup
4. **Set up monitoring**: Add logging and alerts

## Production Checklist

Before going to production:

- [ ] Switch `ETRADE_SANDBOX=false`
- [ ] Use production E*TRADE credentials
- [ ] Deploy to a VPS or cloud service
- [ ] Set up SSL/HTTPS
- [ ] Use managed PostgreSQL (RDS, etc.)
- [ ] Deploy Lambda scheduler for redundancy
- [ ] Set up CloudWatch monitoring
- [ ] Enable database backups
- [ ] Add authentication to web interface
- [ ] Test thoroughly with small orders first!

## Support

If you run into issues:
1. Check the logs in each terminal
2. Verify .env configuration
3. Test database connection
4. Check E*TRADE API credentials
5. Review the README.md for detailed documentation
