# Market analysis skill bundle for another agent

This file packages the workflow, repo changes, and handoff notes for moving-average analysis in this repo.

Repo:
- `/root/repos/etrade-trade-placer`

## What this workflow does

A minimal market-analysis CLI was added that:
- accepts a fungible symbol argument
- tries E*TRADE first for the latest quote
- falls back honestly when E*TRADE is unavailable
- computes:
  - Daily SMAs: 200, 150, 100, 50, 20, 14, 13, 10, 9, 5
  - Weekly SMAs: 14, 10
  - 5-minute 9 EMA
  - Daily 10-day EMA cut signal
- prints exact data source and freshness for each timeframe
- says explicitly when true live 5-minute data is not available

## Commands

From repo root:

```bash
npm run analyze -- MU
npm run analyze -- LLY
npx tsx src/scripts/analyze-market.ts /CL --history-symbol=CL=F
```

## Files changed

1. `src/scripts/analyze-market.ts`
   - New reusable analyzer CLI
   - Uses E*TRADE quote integration for latest price when OAuth is valid
   - Uses Yahoo Finance chart API for daily, weekly, and 5-minute bar history
   - Computes requested SMA/EMA values
   - Reports daily 10-day EMA cut signal as above / below / crossing up / crossing down
   - Reports 5-minute 9 EMA and whether price is above or below it
   - Supports symbol override for Yahoo history via `--history-symbol=`

2. `package.json`
   - Added:
   ```json
   "analyze": "tsx src/scripts/analyze-market.ts"
   ```

## Changes intentionally not kept

- I ran `npm install` locally so `tsx` would be available for execution, but I reverted the `package-lock.json` changes.
- I investigated automated OAuth, but I did not land an OAuth code fix yet.
- No OAuth source files were changed.

## Data-source decisions

### Latest price
Primary choice:
- E*TRADE Market Quote API via existing repo integration

If E*TRADE latest quote fails:
- fall back to Yahoo Finance chart latest market price
- say why, e.g. expired OAuth token

### Daily / weekly / 5-minute history
Use:
- Yahoo Finance chart API

Reason:
- repo evidence showed `GET /v1/market/timesales/{symbol}` testing returned 404 (`Resource not found`)
- so the current broker integration is not a reliable source for the historical bar series required by these indicators

### Freshness labels used
- E*TRADE quoteStatus REALTIME -> live
- E*TRADE quoteStatus DELAYED -> delayed
- Yahoo 5-minute -> delayed
- Yahoo daily/weekly during market hours -> delayed
- Yahoo daily/weekly after market -> end-of-day

## Output contract

The analyzer prints:
- latest price
- all requested daily SMAs
- requested weekly SMAs
- daily 10-day EMA and cut signal
- 5-minute 9 EMA and price relation
- exact source and freshness for each timeframe
- explicit note when true live 5-minute data is unavailable

## Bounce-analysis method

For questions like:
- "Did LLY bounce off any moving averages recently?"

Use this method:

1. Pull recent daily bars.
2. Compute same-day SMAs for: 200, 150, 100, 50, 20, 14, 13, 10, 9, 5.
3. Identify the recent 60-session low and/or most recent local swing low.
4. Compare that day’s low to the same-day MA values.
5. Rank by percent distance from the low.
6. Check whether the MA was within that day’s range.
7. Check whether the close finished back above the MA.

Interpretation language:
- "clean bounce off X-day SMA" = tagged/undercut and reclaimed/held
- "rebound from around X-day SMA area" = near it, but not a textbook hold
- "not a textbook bounce" = closest MA was nearby, but price closed below it

## Example preliminary read for LLY

Using recent daily data, the most recent meaningful swing low was:
- 2026-03-27
- Low: 877.11
- Close: 878.24

Closest MA that day:
- 200-day SMA: 895.68

Interpretation:
- price traded into the 200-day area intraday
- but closed below the 200-day SMA that day
- so it was more of a rebound from around the 200-day area than a clean textbook bounce off it

## Open OAuth note

Automated OAuth investigation found a likely brittle step in:
- `src/server/routes/auth.ts`

Current likely pain point:
- `page.goto(authUrl, { waitUntil: 'networkidle2', timeout: 30000 })`

This appears too brittle for E*TRADE’s authorization page and can time out before the later login/verification logic runs. No fix was committed yet.

## Shareable Hermes skill created

A reusable Hermes skill was also created:
- `research/market-analysis-bounce-check`

That skill describes:
- when to use the workflow
- exact commands
- data-source policy
- bounce-analysis methodology
- pitfalls and verification steps
