# E\*TRADE API Test Results

**Test Date:** 2026-01-25T17:22:39.770Z
**Mode:** PRODUCTION

## Summary

- **Total Tests:** 21
- **✓ Working:** 15
- **✗ Failed:** 6
- **⏭ Skipped:** 0

---

## ✓ Working APIs

### Accounts

#### List Accounts

- **Method:** GET
- **URL:** `https://api.etrade.com/v1/accounts/list`
- **Status:** 200
- **X-ET-Trace:** 26330c27e4e25d608e75bc44391dcf94

#### Get Account Balances

- **Method:** GET
- **URL:** `https://api.etrade.com/v1/accounts/ACCOUNT_KEY_PLACEHOLDER/balance?instType=BROKERAGE&realTimeNAV=true`
- **Status:** 200
- **X-ET-Trace:** f141d4a31c5ba62f310daf36794c785e

#### Get Account Portfolio

- **Method:** GET
- **URL:** `https://api.etrade.com/v1/accounts/ACCOUNT_KEY_PLACEHOLDER/portfolio`
- **Status:** 200
- **X-ET-Trace:** 1583830555e9808e6c69d04aef4cc518

#### Get Account Transactions

- **Method:** GET
- **URL:** `https://api.etrade.com/v1/accounts/ACCOUNT_KEY_PLACEHOLDER/transactions`
- **Status:** 200
- **X-ET-Trace:** b170b80efa2c637bb2f57668786cf30d

### Alerts

#### List Alerts

- **Method:** GET
- **URL:** `https://api.etrade.com/v1/user/alerts`
- **Status:** 200
- **X-ET-Trace:** e90091972dfa44ca0248df03ae323cc3

#### Get Alert Details

- **Method:** GET
- **URL:** `https://api.etrade.com/v1/user/alerts/123456`
- **Status:** 204
- **X-ET-Trace:** eaf9c5d19f0b0ff8b067fce9215db826

### Market

#### Get Quote

- **Method:** GET
- **URL:** `https://api.etrade.com/v1/market/quote/AAPL`
- **Status:** 200
- **X-ET-Trace:** 54fdeff2ab3db372764395a40f76751b

#### Get Multiple Quotes

- **Method:** GET
- **URL:** `https://api.etrade.com/v1/market/quote/AAPL,MSFT,GOOGL`
- **Status:** 200
- **X-ET-Trace:** e7880c096efafebc254e2c9efa23c6b3

#### Get Options Chain

- **Method:** GET
- **URL:** `https://api.etrade.com/v1/market/optionchains?symbol=AAPL`
- **Status:** 200
- **X-ET-Trace:** bf4a3eb88b44edb127e9fad87a790175

#### Get Options Chain with Expiration

- **Method:** GET
- **URL:** `https://api.etrade.com/v1/market/optionchains?symbol=AAPL&expiryDate=20260201`
- **Status:** 200
- **X-ET-Trace:** c262e237e94ad0b9705e4ce54ad24003

#### Get Options Chain with Strike

- **Method:** GET
- **URL:** `https://api.etrade.com/v1/market/optionchains?symbol=AAPL&strikePrice=200`
- **Status:** 200
- **X-ET-Trace:** fad782956840f54b64e463a4100eeac6

#### Product Lookup

- **Method:** GET
- **URL:** `https://api.etrade.com/v1/market/lookup/AAPL`
- **Status:** 200
- **X-ET-Trace:** 3227cdcc97ea9ba2e3bb905d58987d54

#### Get Option Expiration Dates

- **Method:** GET
- **URL:** `https://api.etrade.com/v1/market/optionexpiredate?symbol=AAPL`
- **Status:** 200
- **X-ET-Trace:** e935833c3a3186ed8549922ffddff6e5

### Orders

#### List Orders

- **Method:** GET
- **URL:** `https://api.etrade.com/v1/accounts/ACCOUNT_KEY_PLACEHOLDER/orders`
- **Status:** 204
- **X-ET-Trace:** be337123677fa87dab326f9a6b626696

#### Get Order Details

- **Method:** GET
- **URL:** `https://api.etrade.com/v1/accounts/ACCOUNT_KEY_PLACEHOLDER/orders/123456`
- **Status:** 204
- **X-ET-Trace:** e71eac8b05f1ff2b096092de00a2e797

---

## ✗ Non-Working APIs

### Market

#### Market News

- **Method:** GET
- **URL:** `https://api.etrade.com/v1/market/news/AAPL`
- **Status:** 401
- **Error:** `<Error>
  <message>Unauthorized request</message>
</Error>`

#### Time and Sales

- **Method:** GET
- **URL:** `https://api.etrade.com/v1/market/timesales/AAPL`
- **Status:** 404
- **Error:** `<Error>
  <message>Resource not found</message>
</Error>`

#### Market Movers

- **Method:** GET
- **URL:** `https://api.etrade.com/v1/market/movers`
- **Status:** 401
- **Error:** `<Error>
  <message>Unauthorized request</message>
</Error>`

#### Market Movers by Index

- **Method:** GET
- **URL:** `https://api.etrade.com/v1/market/movers/DOW`
- **Status:** 401
- **Error:** `<Error>
  <message>Unauthorized request</message>
</Error>`

### Orders

#### Preview Order

- **Method:** POST
- **URL:** `https://api.etrade.com/v1/accounts/{accountIdKey}/orders/preview`
- **Status:** 500
- **Description:** Previews an order before placing (required step before placing orders)
- **Error Code:** 100
- **Error:** `The requested service is not currently available, please try after sometime.`
- **Note:** This is a known E\*TRADE service issue - the order preview service is intermittently (i.e. always) unavailable
- **X-ET-Trace:** ba39ad085e1ce4f2c975324b1db4f729

#### Place Order

- **Method:** POST
- **URL:** `https://api.etrade.com/v1/accounts/{accountIdKey}/orders/place`
- **Status:** 400
- **Description:** Places an order using a previewId from the preview step
- **Error Code:** 9999
- **Error:** `Please validate the input and try again`
- **Note:** Tested with dummy previewId. Endpoint structure is correct - requires a valid previewId from a successful preview step. The 400 error is expected when using an invalid previewId.
- **X-ET-Trace:** 0970075bffff476db9d719d076673c78
- **Order Flow:** E\*TRADE requires a two-step process: 1) Preview order to get previewId, 2) Place order with previewId. Since preview is currently failing (500), orders cannot be placed at this time.
- **X-ET-Trace:** 0970075bffff476db9d719d076673c78
- **Error:** `<Error>
  <code>9999</code>
  <message>Please validate the input and try again</message>
</Error>`
