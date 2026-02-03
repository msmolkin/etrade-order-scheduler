import { ETradeClient } from '../server/services/etrade-client.js';
import type { ETradeCredentials } from '../shared/types/index.js';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

const isSandbox = process.env.ETRADE_SANDBOX === 'true';
const baseUrl = isSandbox ? 'https://apisb.etrade.com' : 'https://api.etrade.com';

const credentials: ETradeCredentials = isSandbox
  ? {
      consumerKey: process.env.ETRADE_SANDBOX_KEY!,
      consumerSecret: process.env.ETRADE_SANDBOX_SECRET!,
      accessToken: process.env.ETRADE_SANDBOX_ACCESS_TOKEN,
      accessTokenSecret: process.env.ETRADE_SANDBOX_ACCESS_TOKEN_SECRET,
    }
  : {
      consumerKey: process.env.ETRADE_CONSUMER_KEY!,
      consumerSecret: process.env.ETRADE_CONSUMER_SECRET!,
      accessToken: process.env.ETRADE_ACCESS_TOKEN,
      accessTokenSecret: process.env.ETRADE_ACCESS_TOKEN_SECRET,
    };

function log(message: string, data?: any) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  if (data !== undefined) {
    console.log(JSON.stringify(data, null, 2));
  }
}

async function listAndPlaceOrder() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     List Orders and Place New Order                         ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  log(`Mode: ${isSandbox ? 'SANDBOX' : 'PRODUCTION'}`);

  const client = new ETradeClient(credentials, isSandbox);

  try {
    // Step 1: Get accounts
    log('Step 1: Fetching accounts...');
    const accounts = await client.getAccounts();
    
    if (!accounts || accounts.length === 0) {
      log('ERROR: No accounts found');
      process.exit(1);
    }

    const accountNickname = process.env.ACCOUNT;
    let accountIdKey: string;
    let accountName: string;

    if (accountNickname) {
      const nicknamesPath = path.join(process.cwd(), '.account-nicknames.json');
      if (fs.existsSync(nicknamesPath)) {
        const nicknames = JSON.parse(fs.readFileSync(nicknamesPath, 'utf-8'));
        const savedAccount = nicknames.find((n: any) => n.nickname === accountNickname);
        if (savedAccount) {
          accountIdKey = savedAccount.accountIdKey;
          accountName = `${savedAccount.accountName} (${accountNickname})`;
        } else {
          const matchingAccount = accounts.find((acc: any) => acc.accountId.endsWith(accountNickname));
          if (matchingAccount) {
            accountIdKey = matchingAccount.accountIdKey;
            accountName = `${matchingAccount.accountDesc} (${accountNickname})`;
          } else {
            log('ERROR: Account not found');
            process.exit(1);
          }
        }
      } else {
        const matchingAccount = accounts.find((acc: any) => acc.accountId.endsWith(accountNickname));
        if (matchingAccount) {
          accountIdKey = matchingAccount.accountIdKey;
          accountName = `${matchingAccount.accountDesc} (${accountNickname})`;
        } else {
          log('ERROR: Account not found');
          process.exit(1);
        }
      }
    } else {
      const activeAccount = accounts.find((acc: any) => acc.accountStatus === 'ACTIVE');
      if (!activeAccount) {
        log('ERROR: No active accounts found');
        process.exit(1);
      }
      accountIdKey = activeAccount.accountIdKey;
      accountName = `${activeAccount.accountDesc || activeAccount.accountName} (${activeAccount.accountId.slice(-4)})`;
    }

    log(`Using account: ${accountName}`);
    log(`Account ID Key: ${accountIdKey}`);

    // Step 2: List orders
    log('\nStep 2: Listing orders...');
    const axios = (await import('axios')).default;
    const OAuth = (await import('oauth-1.0a')).default;
    const crypto = (await import('crypto')).default;

    const oauth = new OAuth({
      consumer: {
        key: credentials.consumerKey!,
        secret: credentials.consumerSecret!,
      },
      signature_method: 'HMAC-SHA1',
      hash_function(base_string, key) {
        return crypto.createHmac('sha1', key).update(base_string).digest('base64');
      },
    });

    function getAuthHeader(url: string, method: string = 'GET') {
      if (!credentials.accessToken || !credentials.accessTokenSecret) {
        throw new Error('Access tokens not set');
      }
      const token = {
        key: credentials.accessToken,
        secret: credentials.accessTokenSecret,
      };
      const authData = oauth.authorize({ url, method }, token);
      return oauth.toHeader(authData);
    }

    const listUrl = `${baseUrl}/v1/accounts/${accountIdKey}/orders`;
    log(`URL: ${listUrl}`);
    const listHeaders = getAuthHeader(listUrl, 'GET');

    let listResponse: any;
    try {
      listResponse = await axios.get(listUrl, {
        headers: {
          ...listHeaders,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      });

      log(`Status: ${listResponse.status}`);
      
      if (listResponse.status === 204 || !listResponse.data || Object.keys(listResponse.data).length === 0) {
        log('No orders found in account');
      } else {
        log('Orders found:');
        const orders = listResponse.data.OrdersResponse?.Order || [];
        log(`Total orders: ${orders.length}`);
        console.log(JSON.stringify(listResponse.data, null, 2));
      }
    } catch (error: any) {
      log(`Error listing orders: ${error.response?.status || error.message}`);
      if (error.response?.data) {
        log('Error details:', error.response.data);
      }
      listResponse = { status: error.response?.status, data: error.response?.data, headers: error.response?.headers };
    }

    // Step 3: Place a new order
    log('\nStep 3: Placing a new order...');
    
    const orderRequest = {
      accountIdKey: accountIdKey,
      symbol: 'AAPL',
      securityType: 'EQ' as const,
      orderAction: 'BUY' as const,
      priceType: 'LIMIT' as const,
      quantity: 1,
      limitPrice: 10,
      orderTerm: 'GOOD_FOR_DAY' as const,
      marketSession: 'REGULAR' as const,
      clientOrderId: `tst${Date.now()}`, // ≤20 alphanumeric (E*TRADE)
    };

    log('Order details:', orderRequest);

    let orderPlacementResult: any = null;
    try {
      const response = await client.placeOrder(orderRequest);
      orderPlacementResult = {
        success: true,
        response: response,
        orderId: (response as any).OrderIds?.[0]?.orderId,
      };
      log('\n✓ Order placed successfully!');
      log('Response:', response);
      
      const orderIds = (response as any).OrderIds;
      if (orderIds && orderIds.length > 0) {
        log(`E*TRADE Order ID: ${orderIds[0].orderId}`);
      }
    } catch (error: any) {
      orderPlacementResult = {
        success: false,
        error: error.message,
        status: error.response?.status,
        response: error.response?.data,
      };
      log('\n✗ Order placement failed');
      log(`Error: ${error.message}`);
      if (error.response) {
        log(`Status: ${error.response.status}`);
        log('Response:', error.response.data);
      }
    }

    // Save results to file
    const resultsDir = path.join(process.cwd(), 'etrade-documentation', 'api-test-results');
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const resultsFile = path.join(resultsDir, `test-results-list-and-place-order-${timestamp}.json`);
    
    const testResults = {
      timestamp: new Date().toISOString(),
      account: {
        accountIdKey,
        accountName,
      },
      listOrders: {
        url: listUrl,
        status: listResponse.status,
        data: listResponse.data,
        xEtTrace: listResponse.headers['x-et-trace'],
      },
      placeOrder: orderPlacementResult,
    };

    fs.writeFileSync(resultsFile, JSON.stringify(testResults, null, 2));
    log(`\n✓ Results saved to: test-results-list-and-place-order-${timestamp}.json`);

  } catch (error: any) {
    log('ERROR: ' + error.message);
    if (error.response) {
      log('Status: ' + error.response.status);
      log('Response:', error.response.data);
    }
    process.exit(1);
  }
}

listAndPlaceOrder();
