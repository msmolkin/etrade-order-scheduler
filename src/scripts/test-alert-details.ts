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

async function testAlertDetails() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     Testing Alert Details with Real Alert ID               ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // Step 1: List alerts
  console.log('Step 1: Listing alerts...');
  const listUrl = `${baseUrl}/v1/user/alerts`;
  const listHeaders = getAuthHeader(listUrl, 'GET');

  try {
    const listResponse = await axios.get(listUrl, {
      headers: {
        ...listHeaders,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    console.log(`✓ Successfully retrieved alerts (Status: ${listResponse.status})`);
    console.log(`X-ET-Trace: ${listResponse.headers['x-et-trace'] || 'N/A'}\n`);

    const alerts = listResponse.data.AlertsResponse?.Alert || [];
    if (alerts.length === 0) {
      console.log('⚠ No alerts found');
      return;
    }

    // Get the latest alert (first one in the list, as they're typically sorted by date)
    const latestAlert = alerts[0];
    const alertId = latestAlert.id;

    console.log(`Found ${alerts.length} alerts`);
    console.log(`Latest Alert ID: ${alertId}`);
    console.log(`Latest Alert Subject: ${latestAlert.subject}`);
    console.log(`Latest Alert Status: ${latestAlert.status}`);
    console.log(`Latest Alert Create Time: ${new Date(latestAlert.createTime * 1000).toISOString()}\n`);

    // Step 2: Get alert details
    console.log(`Step 2: Getting details for alert ${alertId}...`);
    const detailsUrl = `${baseUrl}/v1/user/alerts/${alertId}`;
    const detailsHeaders = getAuthHeader(detailsUrl, 'GET');

    const detailsResponse = await axios.get(detailsUrl, {
      headers: {
        ...detailsHeaders,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    console.log(`✓ Successfully retrieved alert details (Status: ${detailsResponse.status})`);
    console.log(`X-ET-Trace: ${detailsResponse.headers['x-et-trace'] || 'N/A'}\n`);

    console.log('Alert Details Response:');
    console.log(JSON.stringify(detailsResponse.data, null, 2));

    // Save to a new test results JSON file
    const resultsDir = path.join(process.cwd(), 'etrade-documentation', 'api-test-results');
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const resultsFile = path.join(resultsDir, `test-results-alert-details-${timestamp}.json`);
    
    const testResults = [
      {
        category: 'Alerts',
        name: 'List Alerts',
        method: 'GET',
        url: listUrl,
        status: 'SUCCESS',
        statusCode: listResponse.status,
        responseData: listResponse.data,
        xEtTrace: listResponse.headers['x-et-trace'],
        timestamp: new Date().toISOString(),
      },
      {
        category: 'Alerts',
        name: 'Get Alert Details (Real Alert)',
        method: 'GET',
        url: detailsUrl,
        status: 'SUCCESS',
        statusCode: detailsResponse.status,
        responseData: detailsResponse.data,
        xEtTrace: detailsResponse.headers['x-et-trace'],
        timestamp: new Date().toISOString(),
        alertId: alertId,
        alertSubject: latestAlert.subject,
      },
    ];

    fs.writeFileSync(resultsFile, JSON.stringify(testResults, null, 2));
    console.log(`\n✓ Saved test results to: test-results-alert-details-${timestamp}.json`);

    return {
      alertId,
      alertSubject: latestAlert.subject,
      status: detailsResponse.status,
      data: detailsResponse.data,
      xEtTrace: detailsResponse.headers['x-et-trace'],
    };

  } catch (error: any) {
    console.error('✗ Error:', error.response?.status || error.message);
    if (error.response?.data) {
      console.error('Error details:', JSON.stringify(error.response.data, null, 2));
    }
    throw error;
  }
}

testAlertDetails().catch(console.error);
