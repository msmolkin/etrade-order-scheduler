# How to run practice orders

## 1. Get E*TRADE access tokens

```bash
npm run oauth # sandbox mode
```

```bash
ETRADE_SANDBOX=false npm run oauth # production mode
```

## 2. Run the script

```bash
npm run execute:xom-test-order
```

```bash
ETRADE_SANDBOX=false npx tsx src/scripts/buy-aapl.ts
```