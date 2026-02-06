import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

/**
 * Calls E*TRADE's *website* endpoint:
 *   POST https://us.etrade.com/webapitrd/stockorder/previewtsp.json
 *
 * This is NOT the public REST API. It requires an authenticated browser session:
 * - JSESSIONID cookie
 * - stk1 header value
 *
 * Configure via env:
 * - ETRADE_WEB_JSESSIONID   (example: "27B8....")
 * - ETRADE_WEB_STK1        (the stk1 header value, including the leading "/..." as captured)
 * - ETRADE_WEB_ACCOUNT_ID  (example: "...7280" full account id string used by website payload)
 *
 * Per request: this script prints ONLY the response body for each attempt.
 */
async function main() {
  const jsessionid = process.env.ETRADE_WEB_JSESSIONID;
  const stk1 = process.env.ETRADE_WEB_STK1;
  const accountId = process.env.ETRADE_WEB_ACCOUNT_ID;

  if (!jsessionid || !stk1 || !accountId) {
    // Only response body output: emit a JSON body-like error object
    process.stdout.write(
      JSON.stringify({
        error: 'Missing env',
        required: ['ETRADE_WEB_JSESSIONID', 'ETRADE_WEB_STK1', 'ETRADE_WEB_ACCOUNT_ID'],
      }) + '\n'
    );
    process.exit(1);
  }

  const url = 'https://us.etrade.com/webapitrd/stockorder/previewtsp.json';

  const explicit: Array<string | number | null | undefined | boolean> = [
    '3',
    3,
    '2',
    2,
    '1',
    1,
    '4',
    4,
    '5',
    5,
    '0',
    0,
    'REGULAR',
    'EXTENDED',
    true,
    false,
    null,
    undefined,
    '',
    ' ',
  ];

  const brute: Array<string | number> = [];
  for (let i = -2; i <= 20; i++) brute.push(i, String(i));

  const seen = new Set<string>();
  const candidates: Array<string | number | null | undefined | boolean> = [];
  for (const v of [...explicit, ...brute]) {
    const key = `${typeof v}:${String(v)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(v);
  }

  const http = axios.create({
    timeout: 30000,
    withCredentials: true,
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json; charset=UTF-8',
      // Browser session
      Cookie: `JSESSIONID=${jsessionid}`,
      stk1: stk1,
    },
  });

  for (const marketSession of candidates) {
    try {
      const payload = {
        userID: null,
        value: {
          accountId,
          acctDesc: '',
          allOrNone: '',
          complianceReviewValue: '',
          expirationTs: '',
          gtdFlag: '0',
          legRequestList: [{ quantity: '20', symbol: 'SLV', transaction: '2' }],
          limitPrice: '69.95',
          marketSession: marketSession as any,
          orderTerm: '7',
          orderType: 1,
          overrideRestrictedCd: '',
          preClearanceCode: '',
          priceType: '2',
          stopPrice: '',
        },
      };

      const resp = await http.post(url, payload);
      process.stdout.write(JSON.stringify(resp.data) + '\n');
    } catch (e: any) {
      // Only response body
      const body = e?.response?.data ?? e?.message ?? String(e);
      if (typeof body === 'string') {
        process.stdout.write(body.endsWith('\n') ? body : body + '\n');
      } else {
        process.stdout.write(JSON.stringify(body) + '\n');
      }
    }
  }
}

main().catch((e) => {
  const body = (e as any)?.response?.data ?? (e as any)?.message ?? String(e);
  process.stdout.write(typeof body === 'string' ? (body.endsWith('\n') ? body : body + '\n') : JSON.stringify(body) + '\n');
  process.exit(1);
});

