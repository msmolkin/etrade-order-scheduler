#!/usr/bin/env npx tsx
import OAuth from 'oauth-1.0a';
import crypto from 'crypto';
import axios from 'axios';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import 'dotenv/config';
import { buildEtradeAuthorizationUrl } from '../shared/auth/etrade-oauth-url.js';

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
  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log('│  REQUEST: GET /oauth/request_token                          │');
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log(`URL: ${url}?oauth_callback=oob`);
  console.log('\nREQUEST HEADERS:');
  const requestHeaders = {
    ...authHeader,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  console.log(JSON.stringify(requestHeaders, null, 2));

  const response = await axios.get(url, {
    headers: requestHeaders,
    params: { oauth_callback: 'oob' },
  });

  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log('│  RESPONSE: /oauth/request_token                             │');
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log(`STATUS: ${response.status} ${response.statusText}`);
  console.log('\nRESPONSE HEADERS:');
  console.log(JSON.stringify(response.headers, null, 2));
  if (response.headers['x-et-trace']) {
    console.log(`\nX-ET-Trace: ${response.headers['x-et-trace']}`);
  }
  console.log('\nRESPONSE BODY:');
  console.log(response.data);

  const params = new URLSearchParams(response.data);
  const token = params.get('oauth_token');
  const tokenSecret = params.get('oauth_token_secret');

  if (!token || !tokenSecret) {
    throw new Error('Failed to get request token');
  }

  return { token, tokenSecret };
}

function getAuthorizationUrl(requestToken: string): string {
  const authUrl = buildEtradeAuthorizationUrl(CONSUMER_KEY, requestToken);
  
  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log('│  REQUEST: GET /e/t/etws/authorize (Browser Redirect)        │');
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log(`URL: ${authUrl}`);
  console.log('\nQUERY PARAMETERS:');
  console.log(JSON.stringify({
    key: CONSUMER_KEY,
    token: requestToken,
  }, null, 2));
  console.log('\nNOTE: This is a browser redirect. User authenticates on E*TRADE\'s site.');
  console.log('RESPONSE: After login, E*TRADE displays a verification code to the user.');
  
  return authUrl;
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
  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log('│  REQUEST: GET /oauth/access_token                           │');
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log(`URL: ${url}?oauth_verifier=${verifier}`);
  const requestHeaders = {
    ...authHeader,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  console.log('\nREQUEST HEADERS:');
  console.log(JSON.stringify(requestHeaders, null, 2));

  const response = await axios.get(url, {
    headers: requestHeaders,
    params: {
      oauth_verifier: verifier,
    },
  });

  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log('│  RESPONSE: /oauth/access_token                              │');
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log(`STATUS: ${response.status} ${response.statusText}`);
  console.log('\nRESPONSE HEADERS:');
  console.log(JSON.stringify(response.headers, null, 2));
  if (response.headers['x-et-trace']) {
    console.log(`\nX-ET-Trace: ${response.headers['x-et-trace']}`);
  }
  console.log('\nRESPONSE BODY:');
  console.log(response.data);

  const params = new URLSearchParams(response.data);
  const accessToken = params.get('oauth_token');
  const accessTokenSecret = params.get('oauth_token_secret');

  if (!accessToken || !accessTokenSecret) {
    throw new Error('Failed to get access token');
  }

  return { accessToken, accessTokenSecret };
}

function updateEnvFile(accessToken: string, accessTokenSecret: string, isSandbox: boolean): void {
  const envPath = path.join(process.cwd(), '.env');
  let envContent = fs.readFileSync(envPath, 'utf-8');

  const accessTokenKey = isSandbox ? 'ETRADE_SANDBOX_ACCESS_TOKEN' : 'ETRADE_ACCESS_TOKEN';
  const accessTokenSecretKey = isSandbox
    ? 'ETRADE_SANDBOX_ACCESS_TOKEN_SECRET'
    : 'ETRADE_ACCESS_TOKEN_SECRET';

  // Update or add access token
  if (envContent.includes(`${accessTokenKey}=`)) {
    envContent = envContent.replace(
      new RegExp(`${accessTokenKey}=.*`),
      `${accessTokenKey}=${accessToken}`
    );
  } else {
    envContent += `\n${accessTokenKey}=${accessToken}`;
  }

  // Update or add access token secret
  if (envContent.includes(`${accessTokenSecretKey}=`)) {
    envContent = envContent.replace(
      new RegExp(`${accessTokenSecretKey}=.*`),
      `${accessTokenSecretKey}=${accessTokenSecret}`
    );
  } else {
    envContent += `\n${accessTokenSecretKey}=${accessTokenSecret}`;
  }

  fs.writeFileSync(envPath, envContent);
}

const REQUEST_TOKEN_FILE = path.join(process.cwd(), '.oauth_request_token.json');

function normalizeVerifier(verifier: string, source: string): string {
  const normalized = verifier.trim().toUpperCase();
  console.log(`Using uppercase. Using code ${normalized} to authenticate (source: ${source}).`);
  return normalized;
}

function readClipboardText(): string {
  try {
    return execSync('pbpaste', { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

async function main() {
  const phase = process.env.ETRADE_OAUTH_PHASE;
  const verifierFromEnv = process.env.ETRADE_VERIFIER;
  const saveTokens = process.env.ETRADE_SAVE_TOKENS === 'y' || process.env.ETRADE_SAVE_TOKENS === 'yes';

  // Phase 2: complete with verifier (from env or interactive prompt if env fails/missing)
  if (phase === '2') {
    console.log('Checking clipboard first.');
    const clipboardText = readClipboardText().trim();
    let verifierToUse = verifierFromEnv;
    let verifierSource = verifierFromEnv ? 'ETRADE_VERIFIER (.env)' : null;
    if (clipboardText.length === 5) {
      console.log(
        `The clipboard contains 5 characters (${clipboardText.slice(0, 2)}***). Trying this code first.`
      );
      verifierToUse = clipboardText;
      verifierSource = 'clipboard';
    } else if (clipboardText.length === 0) {
      console.log('Clipboard is empty.');
    } else if (clipboardText.length > 5) {
      console.log('Clipboard contains more than 5 characters.');
    } else {
      console.log('Clipboard contains less than 5 characters.');
    }
    const isInteractive = process.stdin.isTTY;

    const runPhase2 = async (verifier: string, source: string): Promise<void> => {
      const raw = fs.readFileSync(REQUEST_TOKEN_FILE, 'utf-8');
      const { token: requestToken, tokenSecret: requestTokenSecret, isSandbox } = JSON.parse(raw);
      const { accessToken, accessTokenSecret } = await getAccessToken(
        requestToken,
        requestTokenSecret,
        normalizeVerifier(verifier, source)
      );
      updateEnvFile(accessToken, accessTokenSecret, isSandbox);
      fs.unlinkSync(REQUEST_TOKEN_FILE);
      console.log('✓ Tokens saved to .env file');
      console.log('OAuth setup complete.');
    };

    // Try verifier from clipboard or env if set
    if (verifierToUse && verifierSource) {
      try {
        await runPhase2(verifierToUse, verifierSource);
        process.exit(0);
        return;
      } catch (error: any) {
        console.error('Error completing OAuth:', error.response?.data || error.message);
        if (!isInteractive) {
          process.exit(1);
          return;
        }
        verifierToUse = undefined;
        verifierSource = null;
      }
    }

    // No verifier or env attempt failed: in interactive shell, ask for code or cancel
    if (isInteractive) {
      const MAX_PHASE2_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_PHASE2_ATTEMPTS; attempt++) {
        const input = await prompt('\nEnter verification code (or press Enter to cancel): ');
        if (!input) {
          console.log('Cancelled. No changes made.');
          process.exit(0);
          return;
        }
        try {
          await runPhase2(input, 'interactive');
          process.exit(0);
          return;
        } catch (error: any) {
          console.error(
            `Error completing OAuth (attempt ${attempt}/${MAX_PHASE2_ATTEMPTS}):`,
            error.response?.data || error.message
          );
          if (attempt < MAX_PHASE2_ATTEMPTS) {
            console.log('Try again.');
          }
        }
      }
      console.error('All phase 2 attempts failed.');
      process.exit(1);
      return;
    }

    // Phase 2, not interactive, no working verifier
    console.error('ETRADE_VERIFIER not set or invalid. Set ETRADE_VERIFIER=<code> or run in an interactive shell to enter the code.');
    process.exit(1);
    return;
  }

  // Phase 1 or interactive: get request token, show URL
  console.log('=================================');
  console.log('E*TRADE OAuth Token Acquisition');
  console.log('=================================');
  console.log(`Mode: ${SANDBOX ? 'SANDBOX' : 'PRODUCTION'}`);
  console.log(`OAuth URL: ${OAUTH_URL}`);
  console.log(`API URL: ${API_URL}`);

  try {
    const { token: requestToken, tokenSecret: requestTokenSecret } = await getRequestToken();
    console.log('✓ Got request token');

    const authUrl = getAuthorizationUrl(requestToken);
    console.log('\n2. Please visit this URL to authorize the application:');
    console.log('\n' + authUrl + '\n');
    console.log('After authorizing, E*TRADE will display a verification code.');

    // Phase 1 only: save request token and exit so verifier can be used in phase 2
    if (phase === '1') {
      fs.writeFileSync(
        REQUEST_TOKEN_FILE,
        JSON.stringify({
          token: requestToken,
          tokenSecret: requestTokenSecret,
          isSandbox: SANDBOX,
        })
      );
      console.log('\nRequest token saved. Run with ETRADE_OAUTH_PHASE=2 ETRADE_VERIFIER=<code> ETRADE_SAVE_TOKENS=y to complete.');
      process.exit(0);
      return;
    }

    const verifier = verifierFromEnv || (await prompt('\n3. Enter the verification code: '));
    if (!verifier) {
      console.error('Error: Verification code is required');
      process.exit(1);
    }

    const { accessToken, accessTokenSecret } = await getAccessToken(
      requestToken,
      requestTokenSecret,
      normalizeVerifier(verifier, verifierFromEnv ? 'ETRADE_VERIFIER (.env)' : 'interactive')
    );
    console.log('\n✓ Successfully obtained access tokens!\n');

    const shouldSave = saveTokens || (await prompt('Save tokens to .env file? (Y/n): '));
    if (shouldSave === true || (typeof shouldSave === 'string' && shouldSave.toLowerCase() !== 'n')) {
      updateEnvFile(accessToken, accessTokenSecret, SANDBOX);
      console.log('\n✓ Tokens saved to .env file');
      console.log('\nRestart your server to use the new tokens.');
    } else {
      console.log('\nAdd these to your .env file:\n');
      if (SANDBOX) {
        console.log(`ETRADE_SANDBOX_ACCESS_TOKEN=${accessToken}`);
        console.log(`ETRADE_SANDBOX_ACCESS_TOKEN_SECRET=${accessTokenSecret}`);
      } else {
        console.log(`ETRADE_ACCESS_TOKEN=${accessToken}`);
        console.log(`ETRADE_ACCESS_TOKEN_SECRET=${accessTokenSecret}`);
      }
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
