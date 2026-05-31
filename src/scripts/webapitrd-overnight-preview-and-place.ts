import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

/**
 * Replays the E*TRADE WEBSITE order flow (not the public REST API):
 *  1) POST https://us.etrade.com/webapitrd/stockorder/previewtsp.json
 *  2) POST https://us.etrade.com/webapitrd/stockorder/placetsp.json
 *
 * This is based directly on your HAR capture in:
 *   etrade-documentation/website-responses/website-place-order-overnight.json
 *
 * Required env:
 * - ETRADE_WEB_JSESSIONID   (cookie value only, not "JSESSIONID=...")
 * - ETRADE_WEB_STK1         (full stk1 header value)
 * - ETRADE_WEB_ACCOUNT_ID   (website numeric accountId, e.g. "YOUR_ACCOUNT_ID")
 *
 * Optional env (defaults match your capture):
 * - ETRADE_WEB_SYMBOL=SLV
 * - ETRADE_WEB_QTY=20
 * - ETRADE_WEB_LIMIT=69.95
 * - ETRADE_WEB_MARKET_SESSION=3
 * - ETRADE_WEB_TRANSACTION=2   (2 = BUY per your capture)
 *
 * Per your request: this script prints ONLY response bodies.
 */
async function main() {
  const jsessionid = process.env.ETRADE_WEB_JSESSIONID;
  const stk1 = process.env.ETRADE_WEB_STK1;
  const accountId = process.env.ETRADE_WEB_ACCOUNT_ID;

  if (!jsessionid || !stk1 || !accountId) {
    process.stdout.write(
      JSON.stringify({
        error: 'Missing env',
        required: ['ETRADE_WEB_JSESSIONID', 'ETRADE_WEB_STK1', 'ETRADE_WEB_ACCOUNT_ID'],
      }) + '\n'
    );
    process.exit(1);
  }

  const symbol = (process.env.ETRADE_WEB_SYMBOL || 'SLV').toUpperCase();
  const quantity = String(process.env.ETRADE_WEB_QTY || '20');
  const limitPrice = String(process.env.ETRADE_WEB_LIMIT || '69.95');
  const marketSessionRaw = process.env.ETRADE_WEB_MARKET_SESSION ?? '3';
  const transaction = String(process.env.ETRADE_WEB_TRANSACTION || '2');

  // In your capture:
  // - preview uses "marketSession":"3" (string)
  // - place uses "marketSession":3 (number)
  const marketSessionForPreview: any = String(marketSessionRaw);
  const marketSessionForPlace: any = /^\d+$/.test(String(marketSessionRaw))
    ? Number(marketSessionRaw)
    : String(marketSessionRaw);

  const http = axios.create({
    timeout: 30000,
    withCredentials: true,
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json; charset=UTF-8',
      Origin: 'https://us.etrade.com',
      Referer: 'https://us.etrade.com/etx/pxy/trading/stocks-etfs/preview',
      Cookie: `JSESSIONID=${jsessionid}`,
      stk1,
    },
    validateStatus: () => true, // we will print body regardless
  });

  // 1) previewtsp.json
  const previewUrl = 'https://us.etrade.com/webapitrd/stockorder/previewtsp.json';
  const previewPayload = {
    userID: null,
    value: {
      accountId,
      acctDesc: '',
      allOrNone: '',
      complianceReviewValue: '',
      expirationTs: '',
      gtdFlag: '0',
      legRequestList: [{ quantity, symbol, transaction }],
      limitPrice,
      marketSession: marketSessionForPreview,
      orderTerm: '7',
      orderType: 1,
      overrideRestrictedCd: '',
      preClearanceCode: '',
      priceType: '2',
      stopPrice: '',
    },
  };

  const previewResp = await http.post(previewUrl, previewPayload);
  process.stdout.write(JSON.stringify(previewResp.data) + '\n');

  const previewId =
    previewResp?.data?.data?.stockPreview?.previewId ??
    previewResp?.data?.data?.previewId ??
    previewResp?.data?.data?.PreviewId ??
    undefined;

  if (!previewId) {
    // Can't proceed to place without previewId (website flow)
    process.exit(0);
  }

  // 2) placetsp.json (based on your captured payload)
  const placeUrl = 'https://us.etrade.com/webapitrd/stockorder/placetsp.json';
  const placePayload = {
    userID: null,
    value: {
      accountId,
      acctDesc: '',
      allOrNone: '0',
      complianceReviewValue: '',
      expirationTs: '',
      gtdFlag: '0',
      legRequestList: [{ cancelQty: '0', quantity, symbol, transaction }],
      limitPrice,
      marketSession: marketSessionForPlace,
      orderTerm: '7',
      orderType: 1,
      overrideRestrictedCd: '',
      preClearanceCode: '',
      priceType: '2',
      stopPrice: '0',
      lotDetails: [],
      overnightIndicatorFlag: '',
      previewId: String(previewId),
      underlier: symbol,
    },
  };

  const placeResp = await http.post(placeUrl, placePayload);
  process.stdout.write(JSON.stringify(placeResp.data) + '\n');
}

main().catch((e) => {
  const body = (e as any)?.response?.data ?? (e as any)?.message ?? String(e);
  process.stdout.write(typeof body === 'string' ? (body.endsWith('\n') ? body : body + '\n') : JSON.stringify(body) + '\n');
  process.exit(1);
});

