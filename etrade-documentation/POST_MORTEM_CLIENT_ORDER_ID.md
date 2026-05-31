# Post-Mortem: E\*TRADE Order Preview/Place 500 Error and clientOrderId Limit

**Date:** February 2026  
**Context:** Placing AAPL buy orders via E\*TRADE production API; comprehensive API testing.

---

## Summary

We saw **HTTP 500** (and sometimes error code **100**: "The requested service is not currently available") when calling the **Preview Order** and **Place Order** endpoints. After contacting E*TRADE support, we learned the root cause: **`clientOrderId` must be 20 or fewer alphanumeric characters**. The official E*TRADE API documentation does not state this limit, so this post-mortem is intended to help others who hit the same 500/server error.

---

## What We Did: Comprehensive API Testing

We built and ran a full API test suite to see which E\*TRADE endpoints work and which fail.

### Test Script

- **Script:** [`src/scripts/test-all-apis.ts`](../src/scripts/test-all-apis.ts)
- **Run (production):** `ETRADE_SANDBOX=false npx tsx src/scripts/test-all-apis.ts`

The script:

1. **Fetches an account ID** from `GET /v1/accounts/list` (so account-specific tests can run).
2. **Runs a fixed list of API tests** across:
   - **Accounts:** List, Balances, Portfolio, Transactions
   - **Market:** Quote, Multiple Quotes, Options Chain, Product Lookup, Expiration Dates, News, Time & Sales, Market Movers, Strike Prices
   - **Orders:** Preview Order, Place Order (with a dummy `previewId` for testing)
   - **Alerts:** List Alerts, Get Alert Details
3. **Logs** method, URL, request body, response status, `X-ET-Trace`, and errors.
4. **Writes results** to `etrade-documentation/api-test-results/`:
   - Raw JSON: `test-results-{timestamp}.json`
   - Human-readable summary: `API_TEST_SUMMARY.md` (working vs non-working APIs).

From that run we saw that most endpoints (Accounts, Market, Alerts) returned 200, while **Preview Order** and **Place Order** often returned **500** or error code **100**, with no clear explanation in the response body.

---

## Symptom: 500 / Error 100 on Preview and Place Order

- **Endpoints:**
  - `POST /v1/accounts/{accountIdKey}/orders/preview`
  - `POST /v1/accounts/{accountIdKey}/orders/place`
- **Observed:** HTTP 500, and sometimes E\*TRADE error code **100** ("The requested service is not currently available").
- **Misleading:** The message suggests a temporary server outage, so it’s easy to assume the problem is on E\*TRADE’s side or transient.

We had been sending `clientOrderId` values like:

- `aapl-buy-${Date.now()}` → e.g. `aapl-buy-1738470679123` (**22+ characters**, and includes hyphens)
- `test-preview-${Date.now()}`, `order-${Date.now()}`, etc.

---

## Root Cause (from E\*TRADE)

After contacting **E\*TRADE’s own support team**, we were told:

> The errors are caused from **clientOrderId having more than 20 characters**.  
> This reference ID may be any value of **20 or fewer alphanumeric characters** but must be **unique within the account**.

So the 500/100 behavior was triggered by **invalid `clientOrderId`** (length and/or non-alphanumeric characters), even though the official REST docs don’t document that constraint.

**Primary source:** E*TRADE’s internal team (via support). The same limit is also mentioned in some open-source E*TRADE API wrappers (e.g. pyetrade, Batil), but we relied on E\*TRADE’s response as the authoritative source.

---

## Fix in This Repo

We generate `clientOrderId` in several places. All were updated to **≤ 20 alphanumeric characters** (no hyphens or other symbols):

| Location                                  | Before                                                   | After                                    |
| ----------------------------------------- | -------------------------------------------------------- | ---------------------------------------- |
| `src/scripts/buy-aapl.ts`                 | `aapl-buy-${Date.now()}`                                 | `aapl${Date.now()}`                      |
| `src/server/services/order-executor.ts`   | `order-${Date.now()}`                                    | `ord${Date.now()}`                       |
| `src/server/routes/orders.ts`             | `'test-' + Date.now()`                                   | `tst${Date.now()}`                       |
| `src/scripts/test-all-apis.ts`            | `test-preview-${Date.now()}`, `test-place-${Date.now()}` | `prev${Date.now()}`, `plac${Date.now()}` |
| `src/scripts/list-and-place-order.ts`     | `test-order-${Date.now()}`                               | `tst${Date.now()}`                       |
| `src/scripts/execute-xom-order.ts`        | `xom-call-sell-${Date.now()}`                            | `xom${Date.now()}`                       |
| `src/scripts/cancel-and-modify-orders.ts` | `modified-${Date.now()}`                                 | `mod${Date.now()}`                       |

`Date.now()` is 13 digits, so patterns like `aapl${Date.now()}` yield 17 characters and stay within the limit while remaining unique in practice.

---

## Recommendation for Other Implementations

- **When generating `clientOrderId`:**
  - Use **at most 20 characters**.
  - Use **only alphanumeric** (e.g. `a–z`, `A–Z`, `0–9`); avoid hyphens, spaces, underscores unless you’ve confirmed they’re accepted.
  - Keep it **unique within the account** (e.g. prefix + timestamp or UUID truncated to 20 chars).
- **If you see 500 or error 100** on Preview/Place Order, check `clientOrderId` length and character set first; the API can fail with a generic server error instead of a clear validation message.
- **When in doubt:** Truncate or generate a string that is ≤ 20 characters (e.g. `clientOrderId.slice(0, 20)` or a 20-char alphanumeric id) to avoid invalid format or 100 errors.

---

## Takeaway

The E*TRADE order preview/place **500 and error 100** we saw were **resolved by enforcing a ≤20 alphanumeric `clientOrderId`**. Because this constraint is not clearly stated in the official API docs, this post-mortem (and E*TRADE support) can help others debugging the same issue.
