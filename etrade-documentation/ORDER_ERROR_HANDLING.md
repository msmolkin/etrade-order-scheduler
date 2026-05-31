# E\*TRADE Order Error Handling

## XML Error Bodies

E\*TRADE order preview/place calls may return XML error bodies even when the
client code is otherwise expecting JSON. Example:

```xml
<Error>
  <code>1037</code>
  <message>We did not find enough available shares of this security in your account for the closing order as placed. Please check the number of shares you entered and resubmit your order. You may also need to check your open orders since shares for this security may already be allocated to an existing open order.</message>
</Error>
```

The order client must parse this before reading `PreviewOrderResponse.PreviewIds`.
If it does not, the user sees a misleading local JavaScript error such as:

```text
Cannot read properties of undefined (reading 'PreviewIds')
```

Correct display/storage should preserve the broker code and message:

```text
E*TRADE error 1037: We did not find enough available shares of this security in your account for the closing order as placed. Please check the number of shares you entered and resubmit your order. You may also need to check your open orders since shares for this security may already be allocated to an existing open order.
```

For code `1037`, check existing open orders for the same symbol because E\*TRADE
may have already allocated those shares to another closing order.

The executor now does that lookup automatically for share-allocation style
errors. It calls `listOrders(accountIdKey, "OPEN")`, filters by
`OrderDetail[].Instrument[].Product.symbol`, and appends the matching open
orders to `last_error`, for example:

```text
Open AMD orders: #8602 OPEN SELL 1 AMD LIMIT limit 465 EXTENDED
```
