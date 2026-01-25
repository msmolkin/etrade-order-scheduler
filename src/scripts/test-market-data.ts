import { ETradeClient } from '../server/services/etrade-client.js';
import type { ETradeCredentials } from '../shared/types/index.js';
import dotenv from 'dotenv';
import axios from 'axios';
import OAuth from 'oauth-1.0a';
import crypto from 'crypto';

dotenv.config();

const SYMBOL = 'AAPL';
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

const oauth = new OAuth({
  consumer: {
    key: credentials.consumerKey,
    secret: credentials.consumerSecret,
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

interface TestResult {
  endpoint: string;
  method: string;
  status: 'SUCCESS' | 'FAILED';
  statusCode?: number;
  error?: string;
  data?: any;
  xEtTrace?: string;
}

const results: TestResult[] = [];

async function testEndpoint(
  name: string,
  url: string,
  method: 'GET' | 'POST' = 'GET',
  body?: any
): Promise<TestResult> {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Testing: ${name}`);
  console.log(`${'='.repeat(80)}`);
  console.log(`URL: ${url}`);
  console.log(`Method: ${method}`);

  try {
    const headers = getAuthHeader(url, method);
    const config: any = {
      method,
      url,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    };

    if (body) {
      config.data = body;
      console.log(`Request Body:`, JSON.stringify(body, null, 2));
    }

    const response = await axios(config);
    
    const result: TestResult = {
      endpoint: name,
      method,
      status: 'SUCCESS',
      statusCode: response.status,
      data: response.data,
      xEtTrace: response.headers['x-et-trace'],
    };

    console.log(`✓ SUCCESS (${response.status})`);
    console.log(`X-ET-Trace: ${response.headers['x-et-trace'] || 'N/A'}`);
    console.log(`Response:`, JSON.stringify(response.data, null, 2));

    return result;
  } catch (error: any) {
    const result: TestResult = {
      endpoint: name,
      method,
      status: 'FAILED',
      statusCode: error.response?.status,
      error: error.response?.data || error.message,
      xEtTrace: error.response?.headers?.['x-et-trace'],
    };

    console.log(`✗ FAILED (${error.response?.status || 'NO RESPONSE'})`);
    if (error.response?.headers?.['x-et-trace']) {
      console.log(`X-ET-Trace: ${error.response.headers['x-et-trace']}`);
    }
    console.log(`Error:`, JSON.stringify(error.response?.data || error.message, null, 2));

    return result;
  }
}

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     E*TRADE Market Data API Test Suite                    ║');
  console.log('║     Testing all available endpoints for AAPL              ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`\nMode: ${isSandbox ? 'SANDBOX' : 'PRODUCTION'}`);
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Symbol: ${SYMBOL}\n`);

  // 1. Quote
  results.push(await testEndpoint(
    'Get Quote',
    `${baseUrl}/v1/market/quote/${SYMBOL}`
  ));

  // 2. Multiple Quotes
  results.push(await testEndpoint(
    'Get Multiple Quotes',
    `${baseUrl}/v1/market/quote/${SYMBOL},MSFT,GOOGL`
  ));

  // 3. Options Chain
  results.push(await testEndpoint(
    'Get Options Chain',
    `${baseUrl}/v1/market/optionchains?symbol=${SYMBOL}`
  ));

  // 4. Options Chain with Expiration
  const today = new Date();
  const nextWeek = new Date(today);
  nextWeek.setDate(today.getDate() + 7);
  const expiryDate = nextWeek.toISOString().split('T')[0].replace(/-/g, '');
  results.push(await testEndpoint(
    'Get Options Chain with Expiration',
    `${baseUrl}/v1/market/optionchains?symbol=${SYMBOL}&expiryDate=${expiryDate}`
  ));

  // 5. Options Chain with Strike Price
  results.push(await testEndpoint(
    'Get Options Chain with Strike Price',
    `${baseUrl}/v1/market/optionchains?symbol=${SYMBOL}&strikePrice=200`
  ));

  // 6. Product Lookup
  results.push(await testEndpoint(
    'Product Lookup',
    `${baseUrl}/v1/market/lookup/${SYMBOL}`
  ));

  // 7. Market News
  results.push(await testEndpoint(
    'Market News',
    `${baseUrl}/v1/market/news/${SYMBOL}`
  ));

  // 8. Time and Sales
  results.push(await testEndpoint(
    'Time and Sales',
    `${baseUrl}/v1/market/timesales/${SYMBOL}`
  ));

  // 9. Time and Sales with Date Range
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 1);
  const endDate = new Date();
  results.push(await testEndpoint(
    'Time and Sales with Date Range',
    `${baseUrl}/v1/market/timesales/${SYMBOL}?startDate=${startDate.toISOString().split('T')[0]}&endDate=${endDate.toISOString().split('T')[0]}`
  ));

  // 10. Market Movers
  results.push(await testEndpoint(
    'Market Movers',
    `${baseUrl}/v1/market/movers`
  ));

  // 11. Market Movers by Index
  results.push(await testEndpoint(
    'Market Movers by Index (DOW)',
    `${baseUrl}/v1/market/movers/DOW`
  ));

  // 12. Market Movers by Direction
  results.push(await testEndpoint(
    'Market Movers Up',
    `${baseUrl}/v1/market/movers/DOW?direction=up`
  ));

  // 13. Market Movers by Change Type
  results.push(await testEndpoint(
    'Market Movers by Percent',
    `${baseUrl}/v1/market/movers/DOW?direction=up&change=percent`
  ));

  // 14. Get Option Expiration Dates
  results.push(await testEndpoint(
    'Get Option Expiration Dates',
    `${baseUrl}/v1/market/optionexpiredate?symbol=${SYMBOL}`
  ));

  // 15. Get Option Strike Prices
  results.push(await testEndpoint(
    'Get Option Strike Prices',
    `${baseUrl}/v1/market/optionstrikeprice?symbol=${SYMBOL}&expiryDate=${expiryDate}`
  ));

  // Print Summary
  console.log('\n\n╔════════════════════════════════════════════════════════════╗');
  console.log('║                    TEST SUMMARY                              ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const successful = results.filter(r => r.status === 'SUCCESS');
  const failed = results.filter(r => r.status === 'FAILED');

  console.log(`Total Tests: ${results.length}`);
  console.log(`✓ Successful: ${successful.length}`);
  console.log(`✗ Failed: ${failed.length}\n`);

  if (successful.length > 0) {
    console.log('SUCCESSFUL ENDPOINTS:');
    console.log('─'.repeat(80));
    successful.forEach(r => {
      console.log(`✓ ${r.endpoint} (${r.method}) - Status: ${r.statusCode}`);
      if (r.xEtTrace) {
        console.log(`  X-ET-Trace: ${r.xEtTrace}`);
      }
    });
  }

  if (failed.length > 0) {
    console.log('\nFAILED ENDPOINTS:');
    console.log('─'.repeat(80));
    failed.forEach(r => {
      console.log(`✗ ${r.endpoint} (${r.method}) - Status: ${r.statusCode || 'NO RESPONSE'}`);
      if (r.xEtTrace) {
        console.log(`  X-ET-Trace: ${r.xEtTrace}`);
      }
      if (r.error) {
        const errorStr = typeof r.error === 'string' ? r.error : JSON.stringify(r.error);
        console.log(`  Error: ${errorStr.substring(0, 200)}${errorStr.length > 200 ? '...' : ''}`);
      }
    });
  }

  console.log('\n' + '='.repeat(80));
}

runTests().catch(console.error);
