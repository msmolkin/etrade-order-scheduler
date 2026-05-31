# E\*TRADE API COMPLETE DOCUMENTATION COMPILATION

## Compiled on January 22, 2026

---

# TABLE OF CONTENTS

1. [Authorization API](#authorization-api)
2. [Accounts API](#accounts-api)
3. [Alerts API](#alerts-api)
4. [Market API](#market-api)
5. [Order API](#order-api)
6. [Getting Started](#getting-started)

---

# AUTHORIZATION API

## Overview

The E\*TRADE REST API uses the OAuth protocol (version 1.0a) to authorize every service request.

## 1. Get Request Token

### Overview

Returns a temporary request token, initiating the OAuth process.

### Description

This API returns a temporary request token that begins the OAuth process. The request token must accompany the user to the authorization page, where the user will grant your application limited access to the account. **The token expires after five minutes.**

### HTTP Method

GET

### Live URL

```
https://api.etrade.com/oauth/request_token
```

### Request Parameters

| Property               | Type   | Required? | Description                                                                           |
| ---------------------- | ------ | --------- | ------------------------------------------------------------------------------------- |
| oauth_consumer_key     | header | yes       | The value used by the consumer to identify itself to the service provider             |
| oauth_timestamp        | header | yes       | The date and time of the request, in epoch time. Must be accurate within five minutes |
| oauth_nonce            | header | yes       | An arbitrary or random value that cannot be used again with the same timestamp        |
| oauth_signature_method | header | yes       | The signature method used. The only supported value is HMAC-SHA1                      |
| oauth_signature        | header | yes       | Signature generated with the shared secret and token secret                           |
| oauth_callback         | header | yes       | Callback information. Must always be set to 'oob'                                     |

### Response

| Status Code | Reason                           |
| ----------- | -------------------------------- |
| 200         | Successful Operation             |
| 400         | There is issue with input        |
| 500         | An unexpected error has occurred |

### Response Properties

| Property                 | Type   | Description                                  |
| ------------------------ | ------ | -------------------------------------------- |
| oauth_token              | string | The consumer's request token                 |
| oauth_token_secret       | string | The token secret                             |
| oauth_callback_confirmed | string | Returns true if a callback URL is configured |

### Example

**Request:**

```
https://api.etrade.com/oauth/request_token
```

**HTTP Header:**

```
Authorization: OAuth realm="",oauth_callback="oob", oauth_signature="FjoSQaFDKEDK1FJazlY3xArNflk%3D", oauth_nonce="LTg2ODUzOTQ5MTEzMTY3MzQwMzE%3D", oauth_signature_method="HMAC-SHA1",oauth_consumer_key="282683cc9e4b8fc81dea6bc687d46758", oauth_timestamp="1273254425"
```

---

## 2. Authorize Application

### Overview

Allows the user to authorize the consumer application.

### Description

Once your application has the request token, it should redirect the user to an E*TRADE authorization page. The URL includes the request token and the consumer key as parameters. Running the URL opens up a page which asks the user to authorize the application. Once the user approves the authorization request, E*TRADE generates a verification code and displays it on the Authorization Complete page.

The user may then manually copy the code and paste it into the application. However, we recommend that the verification code be passed directly to the application via a preconfigured callback URL; in order to do this, the callback URL must be associated with the consumer key. The callback URL may be just a simple address or may also include query parameters. Once the callback is configured, users are automatically redirected to the specified URL with the verification code appended as a query parameter.

### HTTP Method

GET

### Live URL

```
https://us.etrade.com/e/t/etws/authorize
```

### Request Parameters

| Property           | Type   | Required? | Description                                       |
| ------------------ | ------ | --------- | ------------------------------------------------- |
| oauth_consumer_key | header | yes       | The value used by the consumer to identify itself |
| oauth_token        | header | yes       | The consumer's request token                      |

### Response

| Status Code | Reason                           |
| ----------- | -------------------------------- |
| 302         | Redirect url for Authorization   |
| 400         | There is issue with input        |
| 500         | An unexpected error has occurred |

### Response Properties

| Property       | Type         | Description       |
| -------------- | ------------ | ----------------- |
| oauth_verifier | string (uri) | verification code |

### Example

**Request:**

```
https://us.etrade.com/e/t/etws/authorize?key=282683cc9e4b8fc81dea6bc687d46758&token=%2FiQRgQCRGPo7Xdk6G8QDSEzX0Jsy6sKNcULcDavAGgU%3D
```

**Response (Callback Examples):**

```
https://myapplicationsite.com/mytradingapp?oauth_verifier=WXYZ89
https://myapplicationsite.com?myapp=trading&oauth_verifier=WXYZ89
```

---

## 3. Get Access Token

### Overview

Returns an access token.

### Description

This method returns an access token, which confirms that the user has authorized the application to access user data. All calls to the E\*TRADE API (e.g., accountlist, placeequityorder, etc.) must include this access token along with the consumer key, timestamp, nonce, signature method, and signature. This can be done in the query string, but is typically done in the HTTP header.

By default, the access token expires at the end of the current calendar day, US Eastern time. Once the token has expired, no requests will be processed for that token until the OAuth process is repeated - i.e., the user must log in again and the application must secure a new access token. During the current day, if the application does not make any requests for two hours, the access token is inactivated. In this inactive state, the access token is not valid for authorizing requests. It must be reactivated using the Renew Access Token API.

### HTTP Method

GET

### Live URL

```
https://api.etrade.com/oauth/access_token
```

### Request Parameters

| Property               | Type   | Required? | Description                                                                              |
| ---------------------- | ------ | --------- | ---------------------------------------------------------------------------------------- |
| oauth_consumer_key     | header | yes       | The value used by the consumer to identify itself                                        |
| oauth_timestamp        | header | yes       | The date and time of the request, in epoch time. Must be accurate to within five minutes |
| oauth_nonce            | header | yes       | An arbitrary or random value that cannot be used again with the same timestamp           |
| oauth_signature_method | header | yes       | The signature method used (only HMAC-SHA1 is supported)                                  |
| oauth_signature        | header | yes       | Signature generated with the shared secret and token secret                              |
| oauth_token            | header | yes       | The consumer's request token to be exchanged for an access token                         |
| oauth_verifier         | header | yes       | The verification code received by the user                                               |

### Response

| Status Code | Reason                           |
| ----------- | -------------------------------- |
| 200         | Successful Operation             |
| 400         | There is issue with input        |
| 500         | An unexpected error has occurred |

### Response Properties

| Property           | Type    | Description                 |
| ------------------ | ------- | --------------------------- |
| oauth_token        | string  | The consumer's access token |
| oauth_token_secret | integer | The token secret            |

### Notes

- The production access token expires by default at midnight US Eastern time
- Access token and related parameters can be passed with HTTP requests as part of the URL, but we recommend this information be passed in the header instead

---

## 4. Renew Access Token

### Overview

Renews the OAuth access token after two hours or more of inactivity.

### Description

If the application does not make any requests for two hours, the access token is inactivated. In this inactive state, the access token is not valid for authorizing requests. It must be reactivated using the Renew Access Token API. By default the access token expires at midnight US Eastern time. Once the token has expired, no further requests will be processed until the user logs in again and the application secures a new access token.

### HTTP Method

GET

### Live URL

```
https://api.etrade.com/oauth/renew_access_token
```

### Request Parameters

| Property               | Type   | Required? | Description                                                                              |
| ---------------------- | ------ | --------- | ---------------------------------------------------------------------------------------- |
| oauth_consumer_key     | header | yes       | The value used by the consumer to identify itself                                        |
| oauth_timestamp        | header | yes       | The date and time of the request, in epoch time. Must be accurate to within five minutes |
| oauth_nonce            | header | yes       | An arbitrary or random value that cannot be used again with the same timestamp           |
| oauth_signature_method | header | yes       | The signature method used (only HMAC-SHA1 is supported)                                  |
| oauth_signature        | header | yes       | Signature generated with the shared secret and token secret                              |
| oauth_token            | header | yes       | The consumer's access token to be renewed                                                |

### Response

| Status Code | Reason                           |
| ----------- | -------------------------------- |
| 200         | Successful Operation             |
| 400         | There is issue with input        |
| 500         | An unexpected error has occurred |

**Response:** `Access Token has been renewed`

---

## 5. Revoke Access Token

### Overview

Revokes an OAuth access token.

### Description

This method revokes an access token that was granted for the consumer key. Once the token is revoked, it no longer grants access to E*TRADE data. We strongly recommend revoking the access token once your application no longer needs access to the user's E*TRADE account. In the event of a security compromise, a revoked token is useless to a malicious entity.

### HTTP Method

GET

### Live URL

```
https://api.etrade.com/oauth/revoke_access_token
```

### Request Parameters

| Property               | Type   | Required? | Description                                                                              |
| ---------------------- | ------ | --------- | ---------------------------------------------------------------------------------------- |
| oauth_consumer_key     | header | yes       | The value used by the consumer to identify itself                                        |
| oauth_timestamp        | header | yes       | The date and time of the request, in epoch time. Must be accurate to within five minutes |
| oauth_nonce            | header | yes       | An arbitrary or random value that cannot be used again with the same timestamp           |
| oauth_signature_method | header | yes       | The signature method used (only HMAC-SHA1 is supported)                                  |
| oauth_signature        | header | yes       | Signature generated with the shared secret and token secret                              |
| oauth_token            | header | yes       | The consumer's access token to be revoked                                                |

### Response

| Status Code | Reason                           |
| ----------- | -------------------------------- |
| 200         | Successful Operation             |
| 400         | There is issue with input        |
| 500         | An unexpected error has occurred |

**Response:** `Revoked Access Token`

---

# ACCOUNTS API

## Overview

The Accounts APIs retrieve account information including account lists, balances, transactions, and portfolio holdings.

## 1. List Accounts

### Overview

This API returns a list of E\*TRADE accounts for the current user.

### Description

This API returns the account information for the current user. The information returned includes account type, mode, and details.

### HTTP Method

GET

### Live URL

```
https://api.etrade.com/v1/accounts/list
```

### Sandbox URL

```
https://apisb.etrade.com/v1/accounts/list
```

### Response

| Status Code | Reason                           | Error Code |
| ----------- | -------------------------------- | ---------- |
| 200         | Successful operation             |            |
| 204         | No records available             | 105        |
| 500         | Request could not be completed   | 100        |
| 500         | Currently undergoing maintenance | 670        |

### Account Object Properties

| Property        | Type            | Description                  | Possible Values                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | --------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| instNo          | integer         | Institution number           |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| accountId       | string          | The user's account ID        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| accountIdKey    | string          | The unique account key       |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| accountMode     | string          | The account mode             | CASH, MARGIN, CHECKING, IRA, SAVINGS, CD                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| accountDesc     | string          | Description of account       |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| accountName     | string          | The nickname for the account |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| accountType     | string          | The account type             | AMMCHK, ARO, BCHK, BENFIRA, BENFROTHIRA, BENF_ESTATE_IRA, BENF_MINOR_IRA, BENF_ROTH_ESTATE_IRA, BENF_ROTH_MINOR_IRA, BENF_ROTH_TRUST_IRA, BENF_TRUST_IRA, BRKCD, BROKER, CASH, C_CORP, CONTRIBUTORY, COVERDELL_ESA, CONVERSION_ROTH_IRA, CREDITCARD, COMM_PROP, CONSERVATOR, CORPORATION, CSA, CUSTODIAL, DVP, ESTATE, EMPCHK, EMPMMCA, ETCHK, ETMMCHK, HEIL, HELOC, INDCHK, INDIVIDUAL, INDIVIDUAL_K, INVCLUB, INVCLUB_C_CORP, INVCLUB_LLC_C_CORP, INVCLUB_LLC_PARTNERSHIP, INVCLUB_LLC_S_CORP, INVCLUB_PARTNERSHIP, INVCLUB_S_CORP, INVCLUB_TRUST, IRA_ROLLOVER, JOINT, JTTEN, JTWROS, LLC_C_CORP, LLC_PARTNERSHIP, LLC_S_CORP, LLP, LLP_C_CORP, LLP_S_CORP, IRA, IRACD, MONEY_PURCHASE, MARGIN, MRCHK, MUTUAL_FUND, NONCUSTODIAL, NON_PROFIT, OTHER, PARTNER, PARTNERSHIP, PARTNERSHIP_C_CORP, PARTNERSHIP_S_CORP, PDT_ACCOUNT, PM_ACCOUNT, PREFCD, PREFIRACD, PROFIT_SHARING, PROPRIETARY, REGCD, ROTHIRA, ROTH_INDIVIDUAL_K, ROTH_IRA_MINORS, SARSEPIRA, S_CORP, SEPIRA, SIMPLE_IRA, TIC, TRD_IRA_MINORS, TRUST, VARCD, VARIRACD |
| institutionType | string          | The institution type         | BROKERAGE                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| accountStatus   | string          | The status of the account    | ACTIVE, CLOSED                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| closedDate      | integer (int64) | Date when account was closed |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

---

## 2. Get Account Balances

### Overview

This API retrieves the current account balance and related details for a specified account.

### Description

This API returns detailed balance information for a specified account for the current user. The information returned includes account type, option level, and details on up to four balances - account balance, margin account balance, day trade balance, and cash account balance.

### HTTP Method

GET

### Live URL

```
https://api.etrade.com/v1/accounts/{accountIdKey}/balance?instType={instType}&realTimeNAV=true
```

### Sandbox URL

```
https://apisb.etrade.com/v1/accounts/{accountIdKey}/balance?instType={instType}&realTimeNAV=true
```

### Request Parameters

| Property     | Type  | Required? | Description                                          |
| ------------ | ----- | --------- | ---------------------------------------------------- |
| accountIdKey | path  | yes       | The unique account key (from List Accounts API)      |
| instType     | query | yes       | The account institution type (BROKERAGE)             |
| accountType  | query | no        | The registered account type                          |
| realTimeNAV  | query | no        | Default is false. If true, fetches real time balance |

### Response

| Status Code | Reason                                    | Error Code |
| ----------- | ----------------------------------------- | ---------- |
| 200         | Successful operation                      |            |
| 400         | User does not have access on this account | 253        |
| 400         | Account key does not belong to user       | 100        |
| 400         | Invalid institution type                  | 7002       |
| 400         | Invalid account                           | 7001       |
| 400         | Please enter valid account key            | 102        |
