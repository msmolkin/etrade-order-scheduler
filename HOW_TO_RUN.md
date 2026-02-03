# How to run practice orders

## 1. Get E*TRADE access tokens

```bash
npm run oauth # sandbox mode
```

```bash
ETRADE_SANDBOX=false npm run oauth # production mode
```

**If you see "E*TRADE session expired or invalid" (401):** Access tokens expire at end of day Eastern time or after 2 hours of inactivity. Re-run the OAuth flow above (same mode as your app, e.g. `ETRADE_SANDBOX=false npm run oauth` for production), then restart the server.

**If the app uses sandbox when you want production:** Your `.env` has `ETRADE_SANDBOX=true`, so `npm run dev` uses sandbox tokens unless you override it. Either run `ETRADE_SANDBOX=false npm run dev`, or set `ETRADE_SANDBOX=false` in `.env` so production is used by default. Check the server startup log: it prints `E*TRADE: SANDBOX` or `E*TRADE: PRODUCTION` so you can confirm which tokens are in use.

## 2. Run the script

```bash
npm run execute:xom-test-order
```

```bash
ETRADE_SANDBOX=false npx tsx src/scripts/buy-aapl.ts
```