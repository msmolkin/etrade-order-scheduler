import { ETradeClient } from '../server/services/etrade-client.js';
import type { ETradeCredentials } from '../shared/types/index.js';
import dotenv from 'dotenv';
import axios from 'axios';
import OAuth from 'oauth-1.0a';
import crypto from 'crypto';
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

interface ApiTest {
  category: string;
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  body?: any;
  description?: string;
  requiresAccountId?: boolean;
}

interface TestResult {
  category: string;
  name: string;
  method: string;
  url: string;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  statusCode?: number;
  error?: string;
  responseData?: any;
  xEtTrace?: string;
  timestamp: string;
}

const results: TestResult[] = [];
let accountIdKey: string | null = null;

async function testEndpoint(test: ApiTest): Promise<TestResult> {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Testing: ${test.category} - ${test.name}`);
  console.log(`${'='.repeat(80)}`);
  console.log(`URL: ${test.url}`);
  console.log(`Method: ${test.method}`);

  // Replace placeholders
  let url = test.url;
  if (test.requiresAccountId && accountIdKey) {
    url = url.replace('{accountIdKey}', accountIdKey);
  }

  try {
    const headers = getAuthHeader(url, test.method);
    const config: any = {
      method: test.method,
      url,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    };

    if (test.body) {
      config.data = test.body;
      console.log(`Request Body:`, JSON.stringify(test.body, null, 2));
    }

    const response = await axios(config);
    
    const result: TestResult = {
      category: test.category,
      name: test.name,
      method: test.method,
      url,
      status: 'SUCCESS',
      statusCode: response.status,
      responseData: response.data,
      xEtTrace: response.headers['x-et-trace'],
      timestamp: new Date().toISOString(),
    };

    console.log(`✓ SUCCESS (${response.status})`);
    if (response.headers['x-et-trace']) {
      console.log(`X-ET-Trace: ${response.headers['x-et-trace']}`);
    }
    const dataPreview = JSON.stringify(response.data).substring(0, 500);
    console.log(`Response Preview: ${dataPreview}${JSON.stringify(response.data).length > 500 ? '...' : ''}`);

    return result;
  } catch (error: any) {
    const result: TestResult = {
      category: test.category,
      name: test.name,
      method: test.method,
      url,
      status: 'FAILED',
      statusCode: error.response?.status,
      error: error.response?.data || error.message,
      xEtTrace: error.response?.headers?.['x-et-trace'],
      timestamp: new Date().toISOString(),
    };

    console.log(`✗ FAILED (${error.response?.status || 'NO RESPONSE'})`);
    if (error.response?.headers?.['x-et-trace']) {
      console.log(`X-ET-Trace: ${error.response.headers['x-et-trace']}`);
    }
    const errorStr = JSON.stringify(error.response?.data || error.message).substring(0, 300);
    console.log(`Error: ${errorStr}${JSON.stringify(error.response?.data || error.message).length > 300 ? '...' : ''}`);

    return result;
  }
}

// Define all API tests based on documentation
const apiTests: ApiTest[] = [
  // ACCOUNTS API
  {
    category: 'Accounts',
    name: 'List Accounts',
    method: 'GET',
    url: `${baseUrl}/v1/accounts/list`,
    description: 'Returns a list of E*TRADE accounts for the current user',
  },
  {
    category: 'Accounts',
    name: 'Get Account Balances',
    method: 'GET',
    url: `${baseUrl}/v1/accounts/{accountIdKey}/balance?instType=BROKERAGE&realTimeNAV=true`,
    description: 'Retrieves the current account balance and related details',
    requiresAccountId: true,
  },
  {
    category: 'Accounts',
    name: 'Get Account Portfolio',
    method: 'GET',
    url: `${baseUrl}/v1/accounts/{accountIdKey}/portfolio`,
    description: 'Retrieves portfolio holdings for a specified account',
    requiresAccountId: true,
  },
  {
    category: 'Accounts',
    name: 'Get Account Transactions',
    method: 'GET',
    url: `${baseUrl}/v1/accounts/{accountIdKey}/transactions`,
    description: 'Retrieves transaction history for a specified account',
    requiresAccountId: true,
  },
  
  // MARKET API
  {
    category: 'Market',
    name: 'Get Quote',
    method: 'GET',
    url: `${baseUrl}/v1/market/quote/AAPL`,
    description: 'Returns quote data for a symbol',
  },
  {
    category: 'Market',
    name: 'Get Multiple Quotes',
    method: 'GET',
    url: `${baseUrl}/v1/market/quote/AAPL,MSFT,GOOGL`,
    description: 'Returns quote data for multiple symbols',
  },
  {
    category: 'Market',
    name: 'Get Options Chain',
    method: 'GET',
    url: `${baseUrl}/v1/market/optionchains?symbol=AAPL`,
    description: 'Returns options chain data for a symbol',
  },
  {
    category: 'Market',
    name: 'Get Options Chain with Expiration',
    method: 'GET',
    url: `${baseUrl}/v1/market/optionchains?symbol=AAPL&expiryDate=20260201`,
    description: 'Returns options chain filtered by expiration date',
  },
  {
    category: 'Market',
    name: 'Get Options Chain with Strike',
    method: 'GET',
    url: `${baseUrl}/v1/market/optionchains?symbol=AAPL&strikePrice=200`,
    description: 'Returns options chain filtered by strike price',
  },
  {
    category: 'Market',
    name: 'Product Lookup',
    method: 'GET',
    url: `${baseUrl}/v1/market/lookup/AAPL`,
    description: 'Returns product information for a symbol',
  },
  {
    category: 'Market',
    name: 'Get Option Expiration Dates',
    method: 'GET',
    url: `${baseUrl}/v1/market/optionexpiredate?symbol=AAPL`,
    description: 'Returns available option expiration dates',
  },
  {
    category: 'Market',
    name: 'Market News',
    method: 'GET',
    url: `${baseUrl}/v1/market/news/AAPL`,
    description: 'Returns market news for a symbol',
  },
  {
    category: 'Market',
    name: 'Time and Sales',
    method: 'GET',
    url: `${baseUrl}/v1/market/timesales/AAPL`,
    description: 'Returns time and sales data',
  },
  {
    category: 'Market',
    name: 'Market Movers',
    method: 'GET',
    url: `${baseUrl}/v1/market/movers`,
    description: 'Returns market movers',
  },
  {
    category: 'Market',
    name: 'Market Movers by Index',
    method: 'GET',
    url: `${baseUrl}/v1/market/movers/DOW`,
    description: 'Returns market movers for an index',
  },
  
  // ORDERS API
  {
    category: 'Orders',
    name: 'Preview Order',
    method: 'POST',
    url: `${baseUrl}/v1/accounts/{accountIdKey}/orders/preview`,
    description: 'Previews an order before placing',
    requiresAccountId: true,
    body: {
      PreviewOrderRequest: {
        orderType: 'EQ',
        clientOrderId: `test-preview-${Date.now()}`,
        Order: [{
          allOrNone: false,
          priceType: 'LIMIT',
          orderTerm: 'GOOD_FOR_DAY',
          marketSession: 'REGULAR',
          Instrument: [{
            Product: {
              securityType: 'EQ',
              symbol: 'AAPL',
            },
            orderAction: 'BUY',
            quantityType: 'QUANTITY',
            quantity: 1,
          }],
          limitPrice: 10,
        }],
      },
    },
  },
  {
    category: 'Orders',
    name: 'List Orders',
    method: 'GET',
    url: `${baseUrl}/v1/accounts/{accountIdKey}/orders`,
    description: 'Lists orders for an account',
    requiresAccountId: true,
  },
  {
    category: 'Orders',
    name: 'Get Order Details',
    method: 'GET',
    url: `${baseUrl}/v1/accounts/{accountIdKey}/orders/123456`,
    description: 'Gets details for a specific order',
    requiresAccountId: true,
  },
  
  // ALERTS API
  {
    category: 'Alerts',
    name: 'List Alerts',
    method: 'GET',
    url: `${baseUrl}/v1/user/alerts`,
    description: 'Lists user alerts',
  },
  {
    category: 'Alerts',
    name: 'Get Alert Details',
    method: 'GET',
    url: `${baseUrl}/v1/user/alerts/123456`,
    description: 'Gets details for a specific alert',
  },
];

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     E*TRADE Complete API Test Suite                        ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`\nMode: ${isSandbox ? 'SANDBOX' : 'PRODUCTION'}`);
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Test Date: ${new Date().toISOString()}\n`);

  // First, get account ID if needed
  try {
    const client = new ETradeClient(credentials, isSandbox);
    const accounts = await client.getAccounts();
    if (accounts && accounts.length > 0) {
      accountIdKey = accounts[0].accountIdKey;
      console.log(`✓ Found account: ${accounts[0].accountDesc} (${accountIdKey})`);
    }
  } catch (error: any) {
    console.log(`⚠ Could not fetch accounts: ${error.message}`);
  }

  // Run all tests
  for (const test of apiTests) {
    if (test.requiresAccountId && !accountIdKey) {
      const result: TestResult = {
        category: test.category,
        name: test.name,
        method: test.method,
        url: test.url,
        status: 'SKIPPED',
        timestamp: new Date().toISOString(),
      };
      results.push(result);
      console.log(`\n⏭ SKIPPED: ${test.name} (no account ID)`);
      continue;
    }
    
    const result = await testEndpoint(test);
    results.push(result);
    
    // Small delay between requests
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Save results
  const resultsDir = path.join(process.cwd(), 'etrade-documentation', 'api-test-results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsFile = path.join(resultsDir, `test-results-${timestamp}.json`);
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));

  // Generate summary document
  generateSummaryDocument(resultsDir, results);

  // Print summary
  printSummary(results);
}

function generateSummaryDocument(resultsDir: string, results: TestResult[]) {
  const working = results.filter(r => r.status === 'SUCCESS');
  const failed = results.filter(r => r.status === 'FAILED');
  const skipped = results.filter(r => r.status === 'SKIPPED');

  let doc = `# E*TRADE API Test Results\n\n`;
  doc += `**Test Date:** ${new Date().toISOString()}\n`;
  doc += `**Mode:** ${isSandbox ? 'SANDBOX' : 'PRODUCTION'}\n\n`;
  doc += `## Summary\n\n`;
  doc += `- **Total Tests:** ${results.length}\n`;
  doc += `- **✓ Working:** ${working.length}\n`;
  doc += `- **✗ Failed:** ${failed.length}\n`;
  doc += `- **⏭ Skipped:** ${skipped.length}\n\n`;

  doc += `---\n\n`;
  doc += `## ✓ Working APIs\n\n`;
  
  const byCategory: Record<string, TestResult[]> = {};
  working.forEach(r => {
    if (!byCategory[r.category]) byCategory[r.category] = [];
    byCategory[r.category].push(r);
  });

  Object.keys(byCategory).sort().forEach(category => {
    doc += `### ${category}\n\n`;
    byCategory[category].forEach(r => {
      doc += `#### ${r.name}\n\n`;
      doc += `- **Method:** ${r.method}\n`;
      doc += `- **URL:** \`${r.url}\`\n`;
      doc += `- **Status:** ${r.statusCode}\n`;
      if (r.xEtTrace) {
        doc += `- **X-ET-Trace:** ${r.xEtTrace}\n`;
      }
      doc += `\n`;
    });
  });

  doc += `---\n\n`;
  doc += `## ✗ Non-Working APIs\n\n`;

  const failedByCategory: Record<string, TestResult[]> = {};
  failed.forEach(r => {
    if (!failedByCategory[r.category]) failedByCategory[r.category] = [];
    failedByCategory[r.category].push(r);
  });

  Object.keys(failedByCategory).sort().forEach(category => {
    doc += `### ${category}\n\n`;
    failedByCategory[category].forEach(r => {
      doc += `#### ${r.name}\n\n`;
      doc += `- **Method:** ${r.method}\n`;
      doc += `- **URL:** \`${r.url}\`\n`;
      doc += `- **Status:** ${r.statusCode || 'NO RESPONSE'}\n`;
      if (r.xEtTrace) {
        doc += `- **X-ET-Trace:** ${r.xEtTrace}\n`;
      }
      if (r.error) {
        const errorStr = typeof r.error === 'string' ? r.error : JSON.stringify(r.error);
        doc += `- **Error:** \`${errorStr.substring(0, 200)}${errorStr.length > 200 ? '...' : ''}\`\n`;
      }
      doc += `\n`;
    });
  });

  if (skipped.length > 0) {
    doc += `---\n\n`;
    doc += `## ⏭ Skipped APIs\n\n`;
    skipped.forEach(r => {
      doc += `- **${r.category} - ${r.name}** (${r.url})\n`;
    });
  }

  const summaryFile = path.join(resultsDir, 'API_TEST_SUMMARY.md');
  fs.writeFileSync(summaryFile, doc);
  console.log(`\n✓ Summary saved to: ${summaryFile}`);
}

function printSummary(results: TestResult[]) {
  console.log('\n\n╔════════════════════════════════════════════════════════════╗');
  console.log('║                    TEST SUMMARY                              ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const successful = results.filter(r => r.status === 'SUCCESS');
  const failed = results.filter(r => r.status === 'FAILED');
  const skipped = results.filter(r => r.status === 'SKIPPED');

  console.log(`Total Tests: ${results.length}`);
  console.log(`✓ Successful: ${successful.length}`);
  console.log(`✗ Failed: ${failed.length}`);
  console.log(`⏭ Skipped: ${skipped.length}\n`);

  if (successful.length > 0) {
    console.log('SUCCESSFUL ENDPOINTS:');
    console.log('─'.repeat(80));
    successful.forEach(r => {
      console.log(`✓ ${r.category} - ${r.name} (${r.method}) - Status: ${r.statusCode}`);
    });
  }

  if (failed.length > 0) {
    console.log('\nFAILED ENDPOINTS:');
    console.log('─'.repeat(80));
    failed.forEach(r => {
      console.log(`✗ ${r.category} - ${r.name} (${r.method}) - Status: ${r.statusCode || 'NO RESPONSE'}`);
    });
  }
}

runTests().catch(console.error);
