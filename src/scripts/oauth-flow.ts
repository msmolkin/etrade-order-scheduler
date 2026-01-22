#!/usr/bin/env npx tsx
import OAuth from 'oauth-1.0a';
import crypto from 'crypto';
import axios from 'axios';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';

const SANDBOX = process.env.ETRADE_SANDBOX === 'true';
// OAuth endpoints always use production URL per E*TRADE documentation
const OAUTH_URL = 'https://api.etrade.com';
// API endpoints use sandbox or production based on config
const API_URL = SANDBOX
  ? 'https://apisb.etrade.com'
  : 'https://api.etrade.com';

// Use sandbox keys when in sandbox mode, otherwise use production keys
const CONSUMER_KEY = SANDBOX
  ? process.env.ETRADE_SANDBOX_KEY
  : process.env.ETRADE_CONSUMER_KEY;
const CONSUMER_SECRET = SANDBOX
  ? process.env.ETRADE_SANDBOX_SECRET
  : process.env.ETRADE_CONSUMER_SECRET;

if (!CONSUMER_KEY || !CONSUMER_SECRET) {
  const keyNames = SANDBOX
    ? 'ETRADE_SANDBOX_KEY and ETRADE_SANDBOX_SECRET'
    : 'ETRADE_CONSUMER_KEY and ETRADE_CONSUMER_SECRET';
  console.error(`Error: ${keyNames} must be set in .env`);
  process.exit(1);
}

const oauth = new OAuth({
  consumer: {
    key: CONSUMER_KEY,
    secret: CONSUMER_SECRET,
  },
  signature_method: 'HMAC-SHA1',
  hash_function(base_string, key) {
    return crypto.createHmac('sha1', key).update(base_string).digest('base64');
  },
});

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function getRequestToken(): Promise<{ token: string; tokenSecret: string }> {
  const url = `${OAUTH_URL}/oauth/request_token`;
  const requestData = {
    url,
    method: 'GET',
    data: { oauth_callback: 'oob' },
  };
  const authData = oauth.authorize(requestData);
  const authHeader = oauth.toHeader(authData);

  console.log('\n1. Requesting OAuth token...');

  const response = await axios.get(url, {
    headers: {
      ...authHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    params: { oauth_callback: 'oob' },
  });

  const params = new URLSearchParams(response.data);
  const token = params.get('oauth_token');
  const tokenSecret = params.get('oauth_token_secret');

  if (!token || !tokenSecret) {
    throw new Error('Failed to get request token');
  }

  return { token, tokenSecret };
}

function getAuthorizationUrl(requestToken: string): string {
  return `https://us.etrade.com/e/t/etws/authorize?key=${CONSUMER_KEY}&token=${requestToken}`;
}

async function getAccessToken(
  requestToken: string,
  requestTokenSecret: string,
  verifier: string
): Promise<{ accessToken: string; accessTokenSecret: string }> {
  const url = `${OAUTH_URL}/oauth/access_token`;

  const token = {
    key: requestToken,
    secret: requestTokenSecret,
  };

  const authData = oauth.authorize(
    { url, method: 'GET', data: { oauth_verifier: verifier } },
    token
  );
  const authHeader = oauth.toHeader(authData);

  console.log('\n4. Exchanging verifier for access token...');

  const response = await axios.get(url, {
    headers: {
      ...authHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    params: {
      oauth_verifier: verifier,
    },
  });

  const params = new URLSearchParams(response.data);
  const accessToken = params.get('oauth_token');
  const accessTokenSecret = params.get('oauth_token_secret');

  if (!accessToken || !accessTokenSecret) {
    throw new Error('Failed to get access token');
  }

  return { accessToken, accessTokenSecret };
}

function updateEnvFile(accessToken: string, accessTokenSecret: string): void {
  const envPath = path.join(process.cwd(), '.env');
  let envContent = fs.readFileSync(envPath, 'utf-8');

  // Update or add ETRADE_ACCESS_TOKEN
  if (envContent.includes('ETRADE_ACCESS_TOKEN=')) {
    envContent = envContent.replace(
      /ETRADE_ACCESS_TOKEN=.*/,
      `ETRADE_ACCESS_TOKEN=${accessToken}`
    );
  } else {
    envContent += `\nETRADE_ACCESS_TOKEN=${accessToken}`;
  }

  // Update or add ETRADE_ACCESS_TOKEN_SECRET
  if (envContent.includes('ETRADE_ACCESS_TOKEN_SECRET=')) {
    envContent = envContent.replace(
      /ETRADE_ACCESS_TOKEN_SECRET=.*/,
      `ETRADE_ACCESS_TOKEN_SECRET=${accessTokenSecret}`
    );
  } else {
    envContent += `\nETRADE_ACCESS_TOKEN_SECRET=${accessTokenSecret}`;
  }

  fs.writeFileSync(envPath, envContent);
}

async function main() {
  console.log('=================================');
  console.log('E*TRADE OAuth Token Acquisition');
  console.log('=================================');
  console.log(`Mode: ${SANDBOX ? 'SANDBOX' : 'PRODUCTION'}`);
  console.log(`OAuth URL: ${OAUTH_URL}`);
  console.log(`API URL: ${API_URL}`);

  try {
    // Step 1: Get request token
    const { token: requestToken, tokenSecret: requestTokenSecret } = await getRequestToken();
    console.log('✓ Got request token');

    // Step 2: Display authorization URL
    const authUrl = getAuthorizationUrl(requestToken);
    console.log('\n2. Please visit this URL to authorize the application:');
    console.log('\n' + authUrl + '\n');
    console.log('After authorizing, E*TRADE will display a verification code.');

    // Step 3: Get verifier from user
    const verifier = await prompt('\n3. Enter the verification code: ');

    if (!verifier) {
      console.error('Error: Verification code is required');
      process.exit(1);
    }

    // Step 4: Exchange verifier for access token
    const { accessToken, accessTokenSecret } = await getAccessToken(
      requestToken,
      requestTokenSecret,
      verifier
    );

    console.log('\n✓ Successfully obtained access tokens!\n');

    // Step 5: Save to .env or display
    const shouldSave = await prompt('Save tokens to .env file? (y/n): ');

    if (shouldSave.toLowerCase() === 'y') {
      updateEnvFile(accessToken, accessTokenSecret);
      console.log('\n✓ Tokens saved to .env file');
      console.log('\nRestart your server to use the new tokens.');
    } else {
      console.log('\nAdd these to your .env file:\n');
      console.log(`ETRADE_ACCESS_TOKEN=${accessToken}`);
      console.log(`ETRADE_ACCESS_TOKEN_SECRET=${accessTokenSecret}`);
    }

    console.log('\n=================================');
    console.log('OAuth setup complete!');
    console.log('=================================\n');
  } catch (error: any) {
    console.error('\nError during OAuth flow:', error.response?.data || error.message);
    process.exit(1);
  }
}

main();
