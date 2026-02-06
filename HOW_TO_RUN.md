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

## Silver price monitor and threshold orders

The script `silver-price-order.ts` polls the silver price every 5 seconds and places an E*TRADE market order for **SLV** (iShares Silver Trust) when the price crosses your high or low threshold.

### APIs you can use for the price

| API | What you get | Access |
|-----|--------------|--------|
| **E*TRADE** (this repo) | SLV share price via `getQuote(['SLV'])` | No extra key; use existing E*TRADE OAuth. |
| **MetalpriceAPI** | Spot silver in USD per troy ounce (XAG) | Sign up at metalpriceapi.com for a free API key. Free tier = daily delay; for 5-second polling a paid tier may be needed. |
| **Metals-API** | Spot precious metals (e.g. silver) | Register at metals-api.com for an API key. |

You choose the source with `SILVER_SOURCE=etrade` or `SILVER_SOURCE=metalpriceapi`. If you use `metalpriceapi`, set `METALPRICEAPI_KEY` in `.env`.

### How SLV relates to silver

**SLV** (iShares Silver Trust) is an ETF that holds physical silver; its share price tracks silver. E*TRADE does not provide spot metal quotes, so the script uses either:

- **Spot silver (metalpriceapi):** Thresholds are in **USD per troy ounce** (e.g. if spot silver drops below 73.35 or rises above 77.93, set `SILVER_LOW=73.35` and `SILVER_HIGH=77.93`).
- **SLV quote (etrade):** Thresholds are in **dollars per SLV share** (e.g. 28 and 32 if you want to trade when SLV crosses those levels).

Orders are always placed in **SLV** (equity) on E*TRADE.

### Env vars

| Variable | Required | Description |
|----------|----------|-------------|
| `SILVER_SOURCE` | No (default: `etrade`) | `etrade` = SLV quote; `metalpriceapi` = spot silver (USD/troy oz). |
| `SILVER_HIGH` | Yes | Upper threshold; trigger when price >= this. |
| `SILVER_LOW` | Yes | Lower threshold; trigger when price <= this. |
| `SILVER_ACTION_HIGH` | No (default: `SELL`) | Order action when high threshold hit: `BUY` or `SELL`. |
| `SILVER_ACTION_LOW` | No (default: `BUY`) | Order action when low threshold hit: `BUY` or `SELL`. |
| `SILVER_QUANTITY` | No (default: 1) | Number of SLV shares per order. |
| `METALPRICEAPI_KEY` | If `SILVER_SOURCE=metalpriceapi` | API key from metalpriceapi.com. |
| `DRY_RUN` | No | Set to `true` to log triggers only (no order placement). |
| `ACCOUNT` | No | E*TRADE account suffix (same as other scripts). |
| `SKIP_PREVIEW` | No | Set to `true` to place without preview (same as other scripts). |

### Run

```bash
SILVER_HIGH=77.93 SILVER_LOW=73.35 npm run silver-price-order
```

With spot silver (MetalpriceAPI):

```bash
SILVER_SOURCE=metalpriceapi SILVER_HIGH=77.93 SILVER_LOW=73.35 METALPRICEAPI_KEY=your_key npm run silver-price-order
```

Dry run (log only, no orders):

```bash
DRY_RUN=true SILVER_HIGH=32 SILVER_LOW=28 npm run silver-price-order
```

The script runs until you stop it (Ctrl+C). It places at most one order per threshold per run.