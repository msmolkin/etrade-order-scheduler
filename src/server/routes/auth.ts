import { Router } from 'express';
import OAuth from 'oauth-1.0a';
import crypto from 'crypto';
import axios from 'axios';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { extractAutoAuthWebhookPayload } from '../../shared/auth/auto-auth-webhook.js';
import { broadcastAuthStatus } from '../ws-broadcast.js';
import { buildEtradeAuthorizationUrl } from '../../shared/auth/etrade-oauth-url.js';

type BrowserElementLike = {
  innerText: string;
  value: string;
  click: () => void;
  dispatchEvent?: (event: unknown) => boolean;
  querySelector: (selector: string) => BrowserElementLike | null;
  getAttribute: (name: string) => string | null;
};

declare const document: {
  readyState: string;
  body: { innerText: string };
  querySelector: (selector: string) => BrowserElementLike | null;
  querySelectorAll: (selector: string) => BrowserElementLike[];
  getElementById: (id: string) => BrowserElementLike | null;
  createEvent: (type: string) => { initEvent: (name: string, bubbles?: boolean, cancelable?: boolean) => void };
};

declare const window: {
  location: { href: string };
};

type HTMLElement = BrowserElementLike;
type HTMLInputElement = BrowserElementLike;

const router = Router();

const SANDBOX = process.env.ETRADE_SANDBOX === 'true';
// OAuth endpoints ALWAYS use production URL per E*TRADE documentation
// Only the API calls use sandbox URL (apisb.etrade.com)
const OAUTH_URL = 'https://api.etrade.com';

// Use sandbox keys when in sandbox mode
const CONSUMER_KEY = SANDBOX
  ? process.env.ETRADE_SANDBOX_KEY!
  : process.env.ETRADE_CONSUMER_KEY!;
const CONSUMER_SECRET = SANDBOX
  ? process.env.ETRADE_SANDBOX_SECRET!
  : process.env.ETRADE_CONSUMER_SECRET!;

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

// Store pending OAuth requests (in production, use Redis or database)
const pendingOAuth: Map<string, { tokenSecret: string; createdAt: Date }> = new Map();

type AutoAuthSession = {
  browser: Browser;
  page: Page;
  requestToken: string;
  requestTokenSecret: string;
  createdAt: number;
  lastActivityAt: number;
};

const activeAutoAuthSessions = new Map<string, AutoAuthSession>();
let autoAuthRunInProgress = false;
const AUTO_AUTH_SESSION_TTL_MS = 10 * 60 * 1000;

async function destroyAutoAuthSession(sessionId: string): Promise<void> {
  const session = activeAutoAuthSessions.get(sessionId);
  if (!session) {
    return;
  }

  activeAutoAuthSessions.delete(sessionId);
  await session.browser.close().catch(() => {});
}

function createAutoAuthSession(browser: Browser, page: Page, requestToken: string, requestTokenSecret: string): string {
  const sessionId = crypto.randomUUID();
  activeAutoAuthSessions.set(sessionId, {
    browser,
    page,
    requestToken,
    requestTokenSecret,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  });
  return sessionId;
}

function getAutoAuthSession(sessionId: string): AutoAuthSession | null {
  const session = activeAutoAuthSessions.get(sessionId) ?? null;
  if (session) {
    session.lastActivityAt = Date.now();
  }
  return session;
}

function getOnlyActiveAutoAuthSession(): { sessionId: string; session: AutoAuthSession } | null {
  const iterator = activeAutoAuthSessions.entries().next();
  if (iterator.done) {
    return null;
  }

  const [sessionId, session] = iterator.value;
  session.lastActivityAt = Date.now();
  return { sessionId, session };
}

// Clean up expired pending OAuth requests and browser sessions (older than 10 minutes)
setInterval(() => {
  const now = new Date();
  for (const [token, data] of pendingOAuth.entries()) {
    if (now.getTime() - data.createdAt.getTime() > AUTO_AUTH_SESSION_TTL_MS) {
      pendingOAuth.delete(token);
    }
  }

  const nowMs = Date.now();
  for (const [sessionId, session] of activeAutoAuthSessions.entries()) {
    if (nowMs - session.lastActivityAt > AUTO_AUTH_SESSION_TTL_MS) {
      void destroyAutoAuthSession(sessionId);
    }
  }
}, 60 * 1000);

// Step 1: Start OAuth flow - returns authorization URL
// E*TRADE only accepts 'oob' callbacks, so user must manually enter the verification code
router.get('/start', async (req, res) => {
  try {
    const url = `${OAUTH_URL}/oauth/request_token`;
    const requestData = {
      url,
      method: 'GET',
      data: { oauth_callback: 'oob' },
    };
    const authData = oauth.authorize(requestData);
    const authHeader = oauth.toHeader(authData);

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

    // Store token secret for later use
    pendingOAuth.set(token, { tokenSecret, createdAt: new Date() });

    const authUrl = buildEtradeAuthorizationUrl(CONSUMER_KEY, token);

    res.json({
      success: true,
      authUrl,
      oauth_token: token,
      message: 'Visit authUrl to authorize. After authorizing, E*TRADE will display a verification code. Submit it to POST /api/auth/verify with { oauth_token, oauth_verifier }',
    });
  } catch (error: any) {
    console.error('OAuth start error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

// Step 2: OAuth callback - receives verifier and exchanges for access token
router.get('/callback', async (req, res) => {
  try {
    const { oauth_token, oauth_verifier } = req.query;

    if (!oauth_token || !oauth_verifier) {
      return res.status(400).json({
        success: false,
        error: 'Missing oauth_token or oauth_verifier',
      });
    }

    // Get stored token secret
    const pending = pendingOAuth.get(oauth_token as string);
    if (!pending) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired oauth_token. Please restart the OAuth flow.',
      });
    }

    const { tokenSecret } = pending;
    pendingOAuth.delete(oauth_token as string);

    // Exchange for access token
    const url = `${OAUTH_URL}/oauth/access_token`;
    const token = {
      key: oauth_token as string,
      secret: tokenSecret,
    };

    const authData = oauth.authorize(
      { url, method: 'GET', data: { oauth_verifier } },
      token
    );
    const authHeader = oauth.toHeader(authData);

    const response = await axios.get(url, {
      headers: {
        ...authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      params: { oauth_verifier },
    });

    const params = new URLSearchParams(response.data);
    const accessToken = params.get('oauth_token');
    const accessTokenSecret = params.get('oauth_token_secret');

    if (!accessToken || !accessTokenSecret) {
      throw new Error('Failed to get access token');
    }

    // Update .env file
    updateEnvFile(accessToken, accessTokenSecret);

    // Update process.env for immediate use
    if (SANDBOX) {
      process.env.ETRADE_SANDBOX_ACCESS_TOKEN = accessToken;
      process.env.ETRADE_SANDBOX_ACCESS_TOKEN_SECRET = accessTokenSecret;
    } else {
      process.env.ETRADE_ACCESS_TOKEN = accessToken;
      process.env.ETRADE_ACCESS_TOKEN_SECRET = accessTokenSecret;
    }

    // Return success page
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>OAuth Success</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 40px; text-align: center; }
            .success { color: #22c55e; font-size: 48px; }
            .message { margin-top: 20px; color: #333; }
            .token { background: #f3f4f6; padding: 10px; border-radius: 4px; font-family: monospace; margin: 10px 0; word-break: break-all; }
          </style>
        </head>
        <body>
          <div class="success">✓</div>
          <h1>OAuth Authorization Successful!</h1>
          <p class="message">Access tokens have been saved to .env file.</p>
          <p class="message">The server will automatically use the new tokens.</p>
          <p><a href="http://localhost:3000">Return to Application</a></p>
        </body>
      </html>
    `);
  } catch (error: any) {
    console.error('OAuth callback error:', error.response?.data || error.message);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>OAuth Error</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 40px; text-align: center; }
            .error { color: #ef4444; font-size: 48px; }
            .message { margin-top: 20px; color: #333; }
          </style>
        </head>
        <body>
          <div class="error">✗</div>
          <h1>OAuth Authorization Failed</h1>
          <p class="message">${error.response?.data || error.message}</p>
          <p><a href="/api/auth/start">Try Again</a></p>
        </body>
      </html>
    `);
  }
});

// Manual verifier entry endpoint (for when callback doesn't work)
router.post('/verify', async (req, res) => {
  try {
    const { oauth_token, oauth_verifier: rawVerifier } = req.body;
    const oauth_verifier = typeof rawVerifier === 'string' ? rawVerifier.trim().toUpperCase() : rawVerifier;

    if (!oauth_token || !oauth_verifier) {
      return res.status(400).json({
        success: false,
        error: 'Missing oauth_token or oauth_verifier in request body',
      });
    }

    // Get stored token secret
    const pending = pendingOAuth.get(oauth_token);
    if (!pending) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired oauth_token. Please restart the OAuth flow.',
      });
    }

    const { tokenSecret } = pending;
    pendingOAuth.delete(oauth_token);

    // Exchange for access token
    const url = `${OAUTH_URL}/oauth/access_token`;
    const token = {
      key: oauth_token,
      secret: tokenSecret,
    };

    const authData = oauth.authorize(
      { url, method: 'GET', data: { oauth_verifier } },
      token
    );
    const authHeader = oauth.toHeader(authData);

    const response = await axios.get(url, {
      headers: {
        ...authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      params: { oauth_verifier },
    });

    const params = new URLSearchParams(response.data);
    const accessToken = params.get('oauth_token');
    const accessTokenSecret = params.get('oauth_token_secret');

    if (!accessToken || !accessTokenSecret) {
      throw new Error('Failed to get access token');
    }

    // Update .env file
    updateEnvFile(accessToken, accessTokenSecret);

    // Update process.env for immediate use
    if (SANDBOX) {
      process.env.ETRADE_SANDBOX_ACCESS_TOKEN = accessToken;
      process.env.ETRADE_SANDBOX_ACCESS_TOKEN_SECRET = accessTokenSecret;
    } else {
      process.env.ETRADE_ACCESS_TOKEN = accessToken;
      process.env.ETRADE_ACCESS_TOKEN_SECRET = accessTokenSecret;
    }

    res.json({
      success: true,
      message: 'Access tokens saved to .env and loaded into server',
    });
  } catch (error: any) {
    console.error('OAuth verify error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

// Check current auth status
router.get('/status', (req, res) => {
  const hasTokens = SANDBOX
    ? !!(process.env.ETRADE_SANDBOX_ACCESS_TOKEN && process.env.ETRADE_SANDBOX_ACCESS_TOKEN_SECRET)
    : !!(process.env.ETRADE_ACCESS_TOKEN && process.env.ETRADE_ACCESS_TOKEN_SECRET);

  res.json({
    authenticated: hasTokens,
    sandbox: SANDBOX,
    consumerKeySet: !!CONSUMER_KEY,
  });
});

function updateEnvFile(accessToken: string, accessTokenSecret: string): void {
  const envPath = path.join(process.cwd(), '.env');
  let envContent = fs.readFileSync(envPath, 'utf-8');

  const accessTokenKey = SANDBOX ? 'ETRADE_SANDBOX_ACCESS_TOKEN' : 'ETRADE_ACCESS_TOKEN';
  const accessTokenSecretKey = SANDBOX ? 'ETRADE_SANDBOX_ACCESS_TOKEN_SECRET' : 'ETRADE_ACCESS_TOKEN_SECRET';

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
  console.log('✓ OAuth tokens saved to .env');
}

// Cookie file path for persisting E*TRADE session
const COOKIES_PATH = path.join(process.cwd(), '.etrade-cookies.json');

// Save cookies to file
async function saveCookies(page: any): Promise<void> {
  const cookies = await page.cookies();
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
  console.log('✓ Cookies saved to .etrade-cookies.json');
}

// Load cookies from file
async function loadCookies(page: any): Promise<boolean> {
  try {
    if (fs.existsSync(COOKIES_PATH)) {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
      await page.setCookie(...cookies);
      console.log('✓ Loaded saved cookies');
      return true;
    }
  } catch (error) {
    console.log('No saved cookies found or error loading them');
  }
  return false;
}

// Helper to pause execution
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function containsChallengeText(text: string): boolean {
  const normalized = text.toLowerCase();
  return [
    'verify your identity',
    'confirm your identity',
    'security code',
    'one-time code',
    'two-factor',
    '2fa',
    'send code',
    'text me',
    'call me',
  ].some((needle) => normalized.includes(needle));
}

function containsAuthorizationActionText(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes('authorize this application')
    || normalized.includes('authorization code')
    || (normalized.includes('accept') && normalized.includes('authorize'))
    || normalized.includes('allow access')
  );
}

function resolvePuppeteerExecutablePath(): string | undefined {
  const explicitCandidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.CHROMIUM_PATH,
  ].filter((value): value is string => !!value && value.trim().length > 0);

  const systemCandidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];

  const playwrightCacheRoot = process.env.PLAYWRIGHT_BROWSERS_PATH
    || path.join(process.env.HOME || '/root', '.cache', 'ms-playwright');

  const playwrightCandidates: string[] = [];
  if (fs.existsSync(playwrightCacheRoot)) {
    const chromiumDirs = fs.readdirSync(playwrightCacheRoot)
      .filter((name) => name.startsWith('chromium-'))
      .sort()
      .reverse();

    for (const dir of chromiumDirs) {
      playwrightCandidates.push(
        path.join(playwrightCacheRoot, dir, 'chrome-linux64', 'chrome'),
        path.join(playwrightCacheRoot, dir, 'chrome-linux', 'chrome')
      );
    }
  }

  const candidates = [...new Set([...explicitCandidates, ...systemCandidates, ...playwrightCandidates])];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function getPageText(page: Page): Promise<string> {
  const evaluateText = page.evaluate(() => document.body?.innerText ?? '');
  const timeout = new Promise<string>((_, reject) => {
    setTimeout(() => reject(new Error('Timed out reading page text via DOM evaluation.')), 5000);
  });

  try {
    return await Promise.race([evaluateText, timeout]);
  } catch {
    const html = await page.content().catch(() => '');
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

async function triggerTwoFactorDelivery(page: Page): Promise<{ sendCodeClicked: string | null; continueClicked: string | null }> {
  const deliveryResultRaw = await page.evaluate(`(() => {
    const triggerPhrases = ['send code', 'text me', 'send text', 'send sms', 'get code', 'call me'];
    const directElements = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a'));
    for (const element of directElements) {
      const text = ((element.innerText || element.value || '') + '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!text || text.includes('resend')) {
        continue;
      }

      let matchesTrigger = false;
      for (const phrase of triggerPhrases) {
        if (text.includes(phrase)) {
          matchesTrigger = true;
          break;
        }
      }

      if (!matchesTrigger) {
        continue;
      }

      element.click();
      return { sendCodeClicked: text, selectedDeliveryOption: false };
    }

    const labels = Array.from(document.querySelectorAll('label'));
    for (const label of labels) {
      const text = ((label.innerText || '') + '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!(text.includes('text') || text.includes('sms') || text.includes('phone'))) {
        continue;
      }

      const radio = label.querySelector('input[type="radio"]') || document.getElementById(label.getAttribute('for') || '');
      if (!radio) {
        continue;
      }

      radio.click();
      return { sendCodeClicked: 'selected: ' + text, selectedDeliveryOption: true };
    }

    return { sendCodeClicked: null, selectedDeliveryOption: false };
  })()`);
  const deliveryResult = deliveryResultRaw as { sendCodeClicked: string | null; selectedDeliveryOption: boolean };

  let continueClicked: string | null = null;
  if (deliveryResult.selectedDeliveryOption) {
    await sleep(2000);
    const continueClickedRaw = await page.evaluate(`(() => {
      const triggerPhrases = ['continue', 'submit', 'next', 'confirm', 'send code', 'text me', 'send text', 'send sms', 'get code', 'call me'];
      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]'));
      for (const button of buttons) {
        const text = ((button.innerText || button.value || '') + '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!text || text.includes('resend')) {
          continue;
        }

        let matchesTrigger = false;
        for (const phrase of triggerPhrases) {
          if (text.includes(phrase)) {
            matchesTrigger = true;
            break;
          }
        }

        if (!matchesTrigger) {
          continue;
        }

        button.click();
        return text;
      }
      return null;
    })()`);
    continueClicked = continueClickedRaw as string | null;
    await sleep(2000);
  }

  return {
    sendCodeClicked: deliveryResult.sendCodeClicked,
    continueClicked,
  };
}

async function submitTwoFactorCode(page: Page, code: string): Promise<void> {
  const trimmedCode = code.trim();
  if (!trimmedCode) {
    throw new Error('A non-empty 2FA code is required.');
  }

  console.log(`2FA submit starting on URL: ${page.url()}`);
  console.log('Waiting for the 2FA input field to become ready...');
  const inputDeadline = Date.now() + 30000;
  let inputState: { found: boolean; inputCount: number; pageTextPreview: string } = { found: false, inputCount: 0, pageTextPreview: '' };

  while (Date.now() < inputDeadline && !inputState.found) {
    inputState = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input, textarea'));
      let found = false;

      for (const input of inputs) {
        const type = (input.getAttribute('type') || '').toLowerCase();
        const id = (input.getAttribute('id') || '').toLowerCase();
        const name = (input.getAttribute('name') || '').toLowerCase();
        const placeholder = (input.getAttribute('placeholder') || '').toLowerCase();
        const autocomplete = (input.getAttribute('autocomplete') || '').toLowerCase();
        const inputmode = (input.getAttribute('inputmode') || '').toLowerCase();
        const haystack = [type, id, name, placeholder, autocomplete, inputmode].join(' ');

        if (
          haystack.includes('code')
          || haystack.includes('otp')
          || haystack.includes('security')
          || haystack.includes('verify')
          || autocomplete === 'one-time-code'
          || type === 'tel'
          || type === 'number'
        ) {
          found = true;
          break;
        }
      }

      const pageText = document.body?.innerText || '';
      return {
        found,
        inputCount: inputs.length,
        pageTextPreview: pageText.slice(0, 400),
      };
    }).catch(() => ({ found: false, inputCount: 0, pageTextPreview: '' }));

    if (inputState.found) {
      break;
    }

    await sleep(500);
  }

  console.log(`2FA input readiness: found=${inputState.found}, inputCount=${inputState.inputCount}`);
  if (!inputState.found) {
    console.log(`2FA input page preview: ${inputState.pageTextPreview.replace(/\s+/g, ' ').trim()}`);
    await page.screenshot({ path: '/tmp/etrade_2fa_input_missing.png' }).catch((error) => {
      console.log(`Skipping 2FA missing-input screenshot after screenshot failure: ${error instanceof Error ? error.message : String(error)}`);
    });
    throw new Error(`Could not find a 2FA input field. Page preview: ${inputState.pageTextPreview}`);
  }

  const fillResult = await page.evaluate((submittedCode) => {
    const inputs = Array.from(document.querySelectorAll('input, textarea'));
    let challengeInput: BrowserElementLike | null = null;

    for (const input of inputs) {
      const type = (input.getAttribute('type') || '').toLowerCase();
      const id = (input.getAttribute('id') || '').toLowerCase();
      const name = (input.getAttribute('name') || '').toLowerCase();
      const placeholder = (input.getAttribute('placeholder') || '').toLowerCase();
      const autocomplete = (input.getAttribute('autocomplete') || '').toLowerCase();
      const inputmode = (input.getAttribute('inputmode') || '').toLowerCase();
      const haystack = [type, id, name, placeholder, autocomplete, inputmode].join(' ');

      if (
        haystack.includes('code')
        || haystack.includes('otp')
        || haystack.includes('security')
        || haystack.includes('verify')
        || autocomplete === 'one-time-code'
        || type === 'tel'
        || type === 'number'
      ) {
        challengeInput = input;
        break;
      }
    }

    if (!challengeInput) {
      challengeInput = inputs[0] || null;
    }

    if (!challengeInput) {
      return { entered: false, target: null };
    }

    const field = challengeInput as BrowserElementLike;
    field.click();

    const prototype = Object.getPrototypeOf(field) as { value?: { set?: (value: string) => void } };
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor?.set) {
      descriptor.set.call(field, submittedCode);
    } else {
      field.value = submittedCode;
    }

    const inputEvent = document.createEvent('Event');
    inputEvent.initEvent('input', true, true);
    field.dispatchEvent?.(inputEvent);
    const changeEvent = document.createEvent('Event');
    changeEvent.initEvent('change', true, true);
    field.dispatchEvent?.(changeEvent);

    return {
      entered: true,
      target: `id=${challengeInput.getAttribute('id') || ''};name=${challengeInput.getAttribute('name') || ''}`,
    };
  }, trimmedCode);

  if (!fillResult.entered) {
    await page.screenshot({ path: '/tmp/etrade_2fa_fill_failed.png' });
    throw new Error('Could not fill the 2FA code field. Screenshot saved to /tmp/etrade_2fa_fill_failed.png');
  }

  console.log(`Filled 2FA code into ${fillResult.target}`);
  await sleep(500);

  await page.evaluate(() => {
    const labelElements = Array.from(document.querySelectorAll('label'));

    for (const label of labelElements) {
      const text = label.innerText.toLowerCase();
      if (!text.includes('do not save this device')) continue;
      const radio = label.querySelector('input[type="radio"]') || document.getElementById(label.getAttribute('for') || '');
      if (radio) {
        (radio as HTMLElement).click();
        return;
      }
    }

    for (const label of labelElements) {
      const text = label.innerText.toLowerCase();
      if (!text.includes('save this device')) continue;
      const radio = label.querySelector('input[type="radio"]') || document.getElementById(label.getAttribute('for') || '');
      if (radio) {
        (radio as HTMLElement).click();
        return;
      }
    }

    const firstRadio = document.querySelector('input[type="radio"]');
    if (firstRadio) {
      (firstRadio as HTMLElement).click();
    }
  });
  await sleep(300);

  const submitClicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]'));
    for (const btn of buttons) {
      const text = ((btn as HTMLElement).innerText || (btn as HTMLInputElement).value || '').toLowerCase();
      if (
        text.includes('submit')
        || text.includes('verify')
        || text.includes('continue')
        || text.includes('next')
        || text.includes('accept')
        || text.includes('confirm')
      ) {
        (btn as HTMLElement).click();
        return text;
      }
    }
    return null;
  });

  if (!submitClicked) {
    await page.keyboard.press('Enter').catch(() => {});
  }

  console.log(`Submitted 2FA code${submitClicked ? ` via ${submitClicked}` : ' via Enter key'}.`);
  await waitForPossibleNavigation(page, 'post-2fa page', 30000);
  await sleep(2000);

  const postCodeText = await getPageText(page);
  if (containsChallengeText(postCodeText)) {
    await page.screenshot({ path: '/tmp/etrade_2fa_code_rejected.png' });
    throw new Error('E*TRADE still shows the 2FA challenge after submitting the code. Screenshot saved to /tmp/etrade_2fa_code_rejected.png');
  }
}

function isNavigationTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('timeout');
}

async function waitForPageReadiness(page: Page, label: string, timeout: number = 15000): Promise<void> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const [title, html, interactiveHandle] = await Promise.all([
      page.title().catch(() => ''),
      page.content().catch(() => ''),
      page.$('input, button, a, form').catch(() => null),
    ]);

    if (title.trim().length > 0 || html.length > 2000 || interactiveHandle) {
      return;
    }

    await sleep(500);
  }

  throw new Error(`${label} did not expose usable page content within ${timeout}ms (current URL: ${page.url()})`);
}

async function gotoWithFallback(page: Page, url: string, label: string, timeout: number = 30000): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  } catch (error) {
    if (!isNavigationTimeoutError(error)) {
      throw error;
    }
    console.warn(`${label}: domcontentloaded timed out after ${timeout}ms; inspecting current page anyway...`);
  }

  try {
    await waitForPageReadiness(page, label, Math.min(timeout, 15000));
  } catch (error) {
    const debugStamp = Date.now();
    const screenshotPath = `/tmp/etrade_authorize_debug_${debugStamp}.png`;
    const htmlPath = `/tmp/etrade_authorize_debug_${debugStamp}.html`;

    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    await fs.promises.writeFile(htmlPath, await page.content().catch(() => ''), 'utf8').catch(() => {});

    const title = await page.title().catch(() => 'unknown');
    throw new Error(
      `${(error as Error).message}. Debug screenshot: ${screenshotPath}. Debug HTML: ${htmlPath}. Page title: ${title}`
    );
  }
}

async function waitForPossibleNavigation(page: Page, label: string, timeout: number = 30000): Promise<void> {
  try {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout });
  } catch (error) {
    if (!isNavigationTimeoutError(error)) {
      throw error;
    }
    console.log(`${label}: no full navigation detected within ${timeout}ms; checking current page state...`);
  }

  try {
    await waitForPageReadiness(page, label, Math.min(timeout, 10000));
  } catch (error) {
    console.log(`${label}: continuing without full readiness (${(error as Error).message})`);
  }
}

// Automated OAuth flow using Puppeteer
// Uses E*TRADE credentials from env vars or request body
// Saves cookies to persist session across runs
// Reload .env so server uses new E*TRADE tokens without restart (getETradeClient reads process.env each time)
router.post('/reload-env', (req, res) => {
  try {
    dotenv.config();
    res.json({ ok: true, message: 'Environment reloaded. New tokens will be used on next request.' });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error?.message ?? 'Failed to reload .env' });
  }
});

router.post('/auto', async (req, res) => {
  const username = req.body.username || process.env.ETRADE_USERNAME;
  const password = req.body.password || process.env.ETRADE_PASSWORD;
  const clearCookies = req.body.clearCookies === true;

  // Check headless preference: request body > env var > default (true)
  let headless: boolean;
  if (req.body.headless !== undefined) {
    headless = req.body.headless;
  } else if (process.env.ETRADE_HEADLESS !== undefined) {
    headless = process.env.ETRADE_HEADLESS === 'true';
  } else {
    headless = true;
  }

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      error: 'E*TRADE credentials required. Provide username/password in request body or set ETRADE_USERNAME/ETRADE_PASSWORD env vars.',
      hint: 'First run with headless=false to establish session and save cookies: curl -X POST http://localhost:3001/api/auth/auto -H "Content-Type: application/json" -d \'{"username":"...","password":"...","headless":false}\'',
    });
  }

  console.log(`Credentials loaded: username=${username ? 'SET' : 'MISSING'}, password=${password ? 'SET' : 'MISSING'}`);

  if (activeAutoAuthSessions.size > 0) {
    return res.status(409).json({
      success: false,
      error: 'An auto-auth session is already waiting for a 2FA code. Submit the code to /api/auth/auto/submit-code before starting another run.',
      sessionIds: Array.from(activeAutoAuthSessions.keys()),
    });
  }

  if (autoAuthRunInProgress) {
    return res.status(409).json({
      success: false,
      error: 'An auto-auth run is already in progress. Wait for it to reach the 2FA step instead of starting a second run.',
    });
  }

  let browser;
  autoAuthRunInProgress = true;
  try {
    console.log(`Starting automated OAuth flow (headless: ${headless})...`);
    console.log('Running with pauses between steps for reliability...');

    if (headless) {
      console.log('TIP: If you encounter verification issues, run with headless=false first to establish a session');
    }

    // Step 1: Get request token
    console.log('\n[Step 1/5] Requesting OAuth token from E*TRADE...');
    await sleep(1000); // Pause before API call
    
    const url = `${OAUTH_URL}/oauth/request_token`;
    const requestData = {
      url,
      method: 'GET',
      data: { oauth_callback: 'oob' },
    };
    const authData = oauth.authorize(requestData);
    const authHeader = oauth.toHeader(authData);

    const tokenResponse = await axios.get(url, {
      headers: {
        ...authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      params: { oauth_callback: 'oob' },
    });

    const tokenParams = new URLSearchParams(tokenResponse.data);
    const requestToken = tokenParams.get('oauth_token');
    const requestTokenSecret = tokenParams.get('oauth_token_secret');

    if (!requestToken || !requestTokenSecret) {
      throw new Error('Failed to get request token');
    }

    // Store for potential manual completion
    pendingOAuth.set(requestToken, { tokenSecret: requestTokenSecret, createdAt: new Date() });

    console.log('✓ Got request token');
    await sleep(1500); // Pause after getting token

    // Step 2: Launch browser and automate authorization
    console.log('\n[Step 2/5] Launching browser for authorization...');
    const authUrl = buildEtradeAuthorizationUrl(CONSUMER_KEY, requestToken);
    console.log(`Auth URL: ${authUrl}`);
    await sleep(1000);

    const executablePath = resolvePuppeteerExecutablePath();
    if (executablePath) {
      console.log(`Using browser executable: ${executablePath}`);
    } else {
      console.log('No explicit browser executable found; falling back to Puppeteer default resolution.');
    }

    browser = await puppeteer.launch({
      headless,
      executablePath,
      protocolTimeout: 120000,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      defaultViewport: { width: 1280, height: 800 },
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(45000);
    page.setDefaultTimeout(45000);

    // Set a realistic user agent
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    console.log('✓ Browser launched');
    await sleep(1000);

    // Optionally clear cookies to force fresh login
    if (clearCookies) {
      console.log('Clearing saved cookies (fresh login)...');
      try {
        if (fs.existsSync(COOKIES_PATH)) {
          fs.unlinkSync(COOKIES_PATH);
          console.log('✓ Cookies cleared');
        }
      } catch (e) {
        console.log('No cookies to clear');
      }
    } else {
      // Load saved cookies if available
      console.log('Loading saved cookies...');
      await loadCookies(page);
    }
    await sleep(500);

    // Navigate to auth URL
    console.log('Navigating to E*TRADE authorization page...');
    await gotoWithFallback(page, authUrl, 'E*TRADE authorization page', 45000);
    console.log('✓ Navigated to E*TRADE authorization page');
    await sleep(2000); // Give page time to fully render

    // Check current page state
    const currentUrl = page.url();
    console.log('Current URL:', currentUrl);
    const pageContent = await page.content();
    const pageText = await getPageText(page);
    
    // Log page state for debugging
    const pagePreviewText = pageText.substring(0, 4000);
    const lowerPagePreviewText = pagePreviewText.toLowerCase();
    console.log('Page text preview (first 500 chars):', pagePreviewText.substring(0, 500).replace(/\n/g, ' '));

    // Check for login form FIRST (most common case) using a bounded preview to avoid expensive scans of giant pages.
    const hasLoginForm =
      (currentUrl.includes('/login') || lowerPagePreviewText.includes('log on') || lowerPagePreviewText.includes('sign in'))
      && lowerPagePreviewText.includes('user id')
      && lowerPagePreviewText.includes('password');
    
    console.log('Login form detected:', hasLoginForm);

    // Check if we're already on the authorization page (cookies worked)
    if (containsAuthorizationActionText(pagePreviewText) && !hasLoginForm) {
      console.log('✓ Session cookies valid - already on authorization page');
    }
    // Check if we hit identity verification (but NOT if login form is present)
    else if (!hasLoginForm && containsChallengeText(pageText)) {
      await page.screenshot({ path: '/tmp/etrade_verification_required.png' });

      const errorMsg = `
Identity verification required by E*TRADE.

Screenshot saved to: /tmp/etrade_verification_required.png

To resolve:
1. Run with headless=false to see the browser:
   curl -X POST http://localhost:3001/api/auth/auto \\
     -H "Content-Type: application/json" \\
     -d '{"username":"${username}","password":"****","headless":false}'

2. Complete the verification manually in the browser window
3. The cookies will be saved for future headless runs

Alternatively, use the manual OAuth flow:
   curl http://localhost:3001/api/auth/start
   # Visit the URL, authorize, then:
   curl -X POST http://localhost:3001/api/auth/verify \\
     -H "Content-Type: application/json" \\
     -d '{"oauth_token":"${requestToken}","oauth_verifier":"CODE_FROM_PAGE"}'
`;

      if (!headless) {
        // Keep browser open for user to complete verification
        console.log('\n' + '='.repeat(60));
        console.log('IDENTITY VERIFICATION REQUIRED');
        console.log('='.repeat(60));
        console.log('Please complete the verification in the browser window.');
        console.log('The browser will wait for you to complete it...');
        console.log('='.repeat(60) + '\n');

        await page.waitForFunction(
          () => {
            const text = document.body.innerText.toLowerCase();
            return !(
              text.includes('verify your identity')
              || text.includes('confirm your identity')
              || text.includes('security code')
              || text.includes('one-time code')
              || text.includes('two-factor')
              || text.includes('2fa')
            );
          },
          { timeout: 300000 }
        ).catch(() => {
          console.log('Timed out waiting for identity verification completion; inspecting current page state...');
        });

        const postVerificationText = await page.evaluate(() => document.body.innerText);
        if (containsChallengeText(postVerificationText)) {
          await page.screenshot({ path: '/tmp/etrade_verification_not_completed.png' });
          throw new Error('Identity verification was not completed. Screenshot saved to /tmp/etrade_verification_not_completed.png');
        }

        // Save cookies after verification
        await saveCookies(page);
      } else {
        throw new Error(errorMsg);
      }
    }
    // Need to log in - use the bounded preview heuristics we computed above.
    else if (hasLoginForm || lowerPagePreviewText.includes('user id') || lowerPagePreviewText.includes('password')) {
      console.log('\n[Step 3/5] Login form detected, entering credentials...');
      console.log(`Will enter username: ${username}`);
      await sleep(1500);

      let loginFieldsFound = false;
      const loginFieldDeadline = Date.now() + 30000;

      while (Date.now() < loginFieldDeadline && !loginFieldsFound) {
        loginFieldsFound = await page.evaluate(() => {
          const userField = document.querySelector('input#USER')
            || document.querySelector('input[name="USER"]')
            || document.querySelector('input[name="user_name"]')
            || document.querySelector('input[type="text"]');
          const passwordField = document.querySelector('input#password')
            || document.querySelector('input#PASSWORD')
            || document.querySelector('input[name="password"]')
            || document.querySelector('input[type="password"]');

          return Boolean(userField && passwordField);
        });

        if (loginFieldsFound) {
          break;
        }

        await sleep(500);
      }

      if (!loginFieldsFound) {
        await page.screenshot({ path: '/tmp/etrade_login_debug.png' });
        throw new Error('Could not find login form fields. Screenshot saved to /tmp/etrade_login_debug.png');
      }

      console.log('Entering username...');
      await sleep(500);

      const filledLoginForm = await page.evaluate((loginUsername, loginPassword) => {
        const userField = (document.querySelector('input#USER')
          || document.querySelector('input[name="USER"]')
          || document.querySelector('input[name="user_name"]')
          || document.querySelector('input[type="text"]')) as BrowserElementLike | null;
        const passwordField = (document.querySelector('input#password')
          || document.querySelector('input#PASSWORD')
          || document.querySelector('input[name="password"]')
          || document.querySelector('input[type="password"]')) as BrowserElementLike | null;
        if (!userField || !passwordField) {
          return false;
        }

        userField.click();
        const userPrototype = Object.getPrototypeOf(userField) as { value?: { set?: (value: string) => void } };
        const userDescriptor = Object.getOwnPropertyDescriptor(userPrototype, 'value');
        if (userDescriptor?.set) {
          userDescriptor.set.call(userField, loginUsername);
        } else {
          userField.value = loginUsername;
        }
        const userInputEvent = document.createEvent('Event');
        userInputEvent.initEvent('input', true, true);
        userField.dispatchEvent?.(userInputEvent);
        const userChangeEvent = document.createEvent('Event');
        userChangeEvent.initEvent('change', true, true);
        userField.dispatchEvent?.(userChangeEvent);

        passwordField.click();
        const passwordPrototype = Object.getPrototypeOf(passwordField) as { value?: { set?: (value: string) => void } };
        const passwordDescriptor = Object.getOwnPropertyDescriptor(passwordPrototype, 'value');
        if (passwordDescriptor?.set) {
          passwordDescriptor.set.call(passwordField, loginPassword);
        } else {
          passwordField.value = loginPassword;
        }
        const passwordInputEvent = document.createEvent('Event');
        passwordInputEvent.initEvent('input', true, true);
        passwordField.dispatchEvent?.(passwordInputEvent);
        const passwordChangeEvent = document.createEvent('Event');
        passwordChangeEvent.initEvent('change', true, true);
        passwordField.dispatchEvent?.(passwordChangeEvent);
        return true;
      }, username, password);

      if (!filledLoginForm) {
        await page.screenshot({ path: '/tmp/etrade_login_fill_failed.png' });
        throw new Error('Could not fill the E*TRADE login form. Screenshot saved to /tmp/etrade_login_fill_failed.png');
      }

      await sleep(1000);
      console.log('✓ Filled login credentials');

      // Find and click login button
      console.log('Clicking login button...');
      await sleep(500);

      const loginButtonText = await page.evaluate(() => {
        const selectors = [
          'button[type="submit"]',
          'input[type="submit"]',
          '#logon_button',
          'button.btn-primary',
          'button[data-testid="login-button"]',
        ];

        for (const selector of selectors) {
          const button = document.querySelector(selector) as BrowserElementLike | null;
          if (!button) {
            continue;
          }

          const text = (button.innerText || button.value || selector).trim();
          button.click();
          return text;
        }

        return null;
      });

      if (loginButtonText) {
        console.log(`Clicked login button: ${loginButtonText}`);
      } else {
        await page.keyboard.press('Enter');
      }

      // Wait for navigation after login
      console.log('Waiting for login to complete...');
      await waitForPossibleNavigation(page, 'post-login page', 30000);
      console.log('✓ Submitted login form');
      await sleep(2000); // Extra pause after login

      const loginStillPresent = await page.evaluate(() => {
        const userField = document.querySelector('input#USER')
          || document.querySelector('input[name="USER"]')
          || document.querySelector('input[name="user_name"]');
        const passwordField = document.querySelector('input#password')
          || document.querySelector('input#PASSWORD')
          || document.querySelector('input[name="password"]')
          || document.querySelector('input[type="password"]');

        return Boolean(userField && passwordField);
      });

      if (loginStillPresent) {
        await page.screenshot({ path: '/tmp/etrade_login_failed.png' });
        throw new Error('E*TRADE login did not complete; still on the sign-in page. Screenshot saved to /tmp/etrade_login_failed.png');
      }

      // Re-check page state after login
      const postLoginText = await page.evaluate(() => document.body.innerText);
      const postLoginUrl = page.url();
      console.log('Post-login URL:', postLoginUrl);
      console.log('Post-login page preview:', postLoginText.substring(0, 300).replace(/\n/g, ' '));

      // Check for 2FA/verification after login
      if (containsChallengeText(postLoginText)) {
        await page.screenshot({ path: '/tmp/etrade_2fa_page.png' });
        console.log('\n' + '='.repeat(60));
        console.log('2FA VERIFICATION REQUIRED');
        console.log('='.repeat(60));

        console.log('Looking for "Send code" button...');
        await sleep(1000);
        const { sendCodeClicked, continueClicked } = await triggerTwoFactorDelivery(page);

        if (sendCodeClicked) {
          console.log(`✓ Clicked: "${sendCodeClicked}"`);
        } else {
          console.log('Could not find "Send code" button automatically');
        }

        if (continueClicked) {
          console.log(`✓ Clicked continue: "${continueClicked}"`);
        }

        console.log('\n' + '='.repeat(60));
        console.log('📱 CHECK YOUR PHONE FOR THE VERIFICATION CODE');
        console.log('='.repeat(60) + '\n');

        if (headless) {
          const sessionId = createAutoAuthSession(browser, page, requestToken, requestTokenSecret);
          browser = undefined;
          return res.status(202).json({
            success: true,
            requiresTwoFactorCode: true,
            sessionId,
            message: 'E*TRADE requested a phone/security code. Submit it to POST /api/auth/auto/submit-code with { sessionId, code }, or forward the SMS payload to POST /api/auth/auto/webhook to continue the same browser session automatically.',
            webhookPath: '/api/auth/auto/webhook',
            sendCodeClicked,
            continueClicked,
          });
        }

        console.log('Enter the code in the browser window within 60 seconds');
        await page.waitForFunction(
          () => {
            const text = document.body.innerText.toLowerCase();
            return !(
              text.includes('verify your identity')
              || text.includes('confirm your identity')
              || text.includes('security code')
              || text.includes('one-time code')
              || text.includes('two-factor')
              || text.includes('2fa')
              || text.includes('send code')
              || text.includes('text me')
              || text.includes('call me')
            );
          },
          { timeout: 60000 }
        ).catch(() => {
          console.log('Timeout waiting for 2FA completion; inspecting current page state...');
        });

        await sleep(2000);
        const postChallengeText = await getPageText(page);
        if (containsChallengeText(postChallengeText)) {
          await page.screenshot({ path: '/tmp/etrade_2fa_not_completed.png' });
          throw new Error('E*TRADE 2FA challenge was not completed. Screenshot saved to /tmp/etrade_2fa_not_completed.png');
        }

        await saveCookies(page);
        console.log('✓ 2FA completed, continuing...');
      }
    }

    // Now try to find and click the Accept button
    console.log('\n[Step 4/5] Looking for authorization acceptance...');
    await sleep(1500);

    // Click Authorize/Accept FIRST. E*TRADE's post-OTP page is the app-grant
    // page; without consenting via that button the request_token is never
    // authorized, and the access_token exchange returns oauth_problem=token_rejected.
    // Earlier code extracted the verifier first and only clicked when extraction
    // failed — but a stray 5-char value in an input field (e.g. "IM0KO") would
    // satisfy extraction, skip the click, and break the entire flow.
    const acceptClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('input[type="submit"], input[type="button"], button, a.button'));
      for (const btn of buttons) {
        const text = ((btn as HTMLElement).innerText || (btn as HTMLInputElement).value || '').toLowerCase();
        if (text.includes('accept') || text.includes('authorize') || text.includes('allow') || text.includes('confirm')) {
          (btn as HTMLElement).click();
          return text;
        }
      }
      return null;
    });

    if (acceptClicked) {
      console.log("✓ Clicked Accept-style button: " + acceptClicked);
      await sleep(1500);
      console.log('Waiting for verification code page...');
      await waitForPossibleNavigation(page, 'verification code page', 15000);
      await sleep(2000); // Extra pause for page to render
      await saveCookies(page);
    } else {
      console.log('No Accept-style button found on post-OTP page — assuming page already shows the verifier.');
      await page.screenshot({ path: '/tmp/etrade_no_accept_button.png' });
    }

    const finalPageText = await page.evaluate(() => document.body.innerText);
    let verifierCode = await extractVerifierCodeFromPage(page, finalPageText);

    if (!verifierCode) {
      await page.screenshot({ path: '/tmp/etrade_no_code.png' });
      throw new Error(`Could not extract verification code. Screenshot saved to /tmp/etrade_no_code.png. You can manually complete: POST /api/auth/verify with {"oauth_token":"${requestToken}","oauth_verifier":"CODE"}`);
    }

    console.log(`✓ Got verification code: ${verifierCode}`);
    await sleep(1000);

    // Wait before closing browser for user to see (reduced to 5 seconds)
    console.log('Verification code obtained. Closing browser in 5 seconds...');
    await sleep(5000);

    // Close browser
    await browser.close();
    browser = undefined;
    console.log('✓ Browser closed');
    await sleep(1000);

    // Step 5: Exchange verifier for access token
    console.log('\n[Step 5/5] Exchanging verification code for access tokens...');
    await sleep(1000);
    
    const accessUrl = `${OAUTH_URL}/oauth/access_token`;
    const accessTokenObj = {
      key: requestToken,
      secret: requestTokenSecret,
    };

    const accessAuthData = oauth.authorize(
      { url: accessUrl, method: 'GET', data: { oauth_verifier: verifierCode } },
      accessTokenObj
    );
    const accessAuthHeader = oauth.toHeader(accessAuthData);

    const accessResponse = await axios.get(accessUrl, {
      headers: {
        ...accessAuthHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      params: { oauth_verifier: verifierCode },
    });

    const accessParams = new URLSearchParams(accessResponse.data);
    const accessToken = accessParams.get('oauth_token');
    const accessTokenSecret = accessParams.get('oauth_token_secret');

    if (!accessToken || !accessTokenSecret) {
      throw new Error('Failed to get access token');
    }

    console.log('✓ Got access tokens');
    await sleep(500);

    // Clean up pending OAuth
    pendingOAuth.delete(requestToken);

    // Save tokens
    console.log('Saving tokens to .env file...');
    updateEnvFile(accessToken, accessTokenSecret);
    
    // Update sandbox-specific env vars if in sandbox mode
    if (SANDBOX) {
      process.env.ETRADE_SANDBOX_ACCESS_TOKEN = accessToken;
      process.env.ETRADE_SANDBOX_ACCESS_TOKEN_SECRET = accessTokenSecret;
    } else {
      process.env.ETRADE_ACCESS_TOKEN = accessToken;
      process.env.ETRADE_ACCESS_TOKEN_SECRET = accessTokenSecret;
    }
    
    console.log('✓ Tokens saved to .env and loaded into process');
    await sleep(500);

    console.log('\n========================================');
    console.log('OAuth flow completed successfully!');
    console.log('========================================\n');

    res.json({
      success: true,
      message: 'Automated OAuth completed successfully. Tokens saved to .env',
      sandbox: SANDBOX,
    });

  } catch (error: any) {
    console.error('Automated OAuth error:', error.message);
    if (error?.stack) {
      console.error(error.stack);
    } else {
      console.error(error);
    }
    if (error.response) {
      console.error('Automated OAuth error status:', error.response.status);
      console.error('Automated OAuth error data:', error.response.data);
    }

    // Make sure browser is closed on error
    if (browser) {
      await browser.close().catch(() => {});
    }

    res.status(500).json({
      success: false,
      error: error.message,
    });
  } finally {
    autoAuthRunInProgress = false;
  }
});

async function completeAutoAuthSession(sessionId: string, session: AutoAuthSession, code: string, sourceLabel: string): Promise<{ sessionId: string; sandbox: boolean }> {
  const trimmedCode = code.trim();
  if (!trimmedCode) {
    throw new Error('A non-empty 2FA code is required.');
  }

  console.log(`Resuming auto-auth session ${sessionId} with a ${sourceLabel} 2FA code...`);
  await submitTwoFactorCode(session.page, trimmedCode);
  await saveCookies(session.page);

  console.log('\n[Step 4/5] Looking for authorization acceptance...');
  await sleep(1500);

  // Click Authorize/Accept FIRST. E*TRADE's post-OTP page is the app-grant
  // page; without consenting via that button the request_token is never
  // authorized, and the access_token exchange returns oauth_problem=token_rejected.
  // Earlier code extracted the verifier first and only clicked when extraction
  // failed — but a stray 5-char value in an input field (e.g. "IM0KO") would
  // satisfy extraction, skip the click, and break the entire flow.
  const postOtpUrl = session.page.url();
  console.log('Post-OTP URL:', postOtpUrl);

  const acceptClicked = await session.page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('input[type="submit"], input[type="button"], button, a.button'));
    for (const btn of buttons) {
      const text = ((btn as HTMLElement).innerText || (btn as HTMLInputElement).value || '').toLowerCase();
      if (text.includes('accept') || text.includes('authorize') || text.includes('allow') || text.includes('confirm')) {
        (btn as HTMLElement).click();
        return text;
      }
    }
    return null;
  });

  if (acceptClicked) {
    console.log("✓ Clicked Accept-style button: " + acceptClicked);
    await sleep(1500);
    console.log('Waiting for verification code page...');
    await waitForPossibleNavigation(session.page, 'verification code page', 15000);
    await sleep(2000);
    await saveCookies(session.page);
  } else {
    console.log('No Accept-style button found on post-OTP page — assuming page already shows the verifier.');
    await session.page.screenshot({ path: '/tmp/etrade_no_accept_button.png' });
  }

  const finalPageText = await getPageText(session.page);
  let verifierCode = await extractVerifierCodeFromPage(session.page, finalPageText);

  if (!verifierCode) {
    await session.page.screenshot({ path: '/tmp/etrade_no_code.png' });
    throw new Error('Could not extract verification code after submitting the 2FA code. Screenshot saved to /tmp/etrade_no_code.png');
  }

  console.log(`✓ Got verification code: ${verifierCode}`);

  const accessUrl = `${OAUTH_URL}/oauth/access_token`;
  const accessTokenObj = {
    key: session.requestToken,
    secret: session.requestTokenSecret,
  };

  const accessAuthData = oauth.authorize(
    { url: accessUrl, method: 'GET', data: { oauth_verifier: verifierCode } },
    accessTokenObj
  );
  const accessAuthHeader = oauth.toHeader(accessAuthData);

  const accessResponse = await axios.get(accessUrl, {
    headers: {
      ...accessAuthHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    params: { oauth_verifier: verifierCode },
  });

  const accessParams = new URLSearchParams(accessResponse.data);
  const accessToken = accessParams.get('oauth_token');
  const accessTokenSecret = accessParams.get('oauth_token_secret');

  if (!accessToken || !accessTokenSecret) {
    throw new Error('Failed to get access token');
  }

  pendingOAuth.delete(session.requestToken);
  updateEnvFile(accessToken, accessTokenSecret);

  if (SANDBOX) {
    process.env.ETRADE_SANDBOX_ACCESS_TOKEN = accessToken;
    process.env.ETRADE_SANDBOX_ACCESS_TOKEN_SECRET = accessTokenSecret;
  } else {
    process.env.ETRADE_ACCESS_TOKEN = accessToken;
    process.env.ETRADE_ACCESS_TOKEN_SECRET = accessTokenSecret;
  }

  await destroyAutoAuthSession(sessionId);

  broadcastAuthStatus({
    authenticated: true,
    sandbox: SANDBOX,
    source: 'auto',
  });

  return {
    sessionId,
    sandbox: SANDBOX,
  };
}

router.post('/auto/submit-code', async (req, res) => {
  const sessionId = typeof req.body.sessionId === 'string' ? req.body.sessionId.trim() : '';
  const code = typeof req.body.code === 'string'
    ? req.body.code.trim()
    : (typeof req.body.twoFactorCode === 'string' ? req.body.twoFactorCode.trim() : '');

  if (!sessionId || !code) {
    return res.status(400).json({
      success: false,
      error: 'sessionId and code are required.',
    });
  }

  const session = getAutoAuthSession(sessionId);
  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Auto-auth session not found or expired. Start /api/auth/auto again.',
    });
  }

  try {
    const result = await completeAutoAuthSession(sessionId, session, code, 'user-provided');
    res.json({
      success: true,
      message: 'Automated OAuth completed successfully after 2FA. Tokens saved to .env',
      sandbox: result.sandbox,
      sessionId: result.sessionId,
    });
  } catch (error: any) {
    console.error('Auto-auth submit-code error:', error.message);
    if (error.response) {
      console.error('Auto-auth submit-code error status:', error.response.status);
      console.error('Auto-auth submit-code error data:', error.response.data);
    }
    res.status(500).json({
      success: false,
      error: error.message,
      sessionId,
      canRetry: activeAutoAuthSessions.has(sessionId),
    });
  }
});

router.post('/auto/webhook', async (req, res) => {
  const expectedSecret = (process.env.ETRADE_AUTO_AUTH_WEBHOOK_SECRET || '').trim();
  const providedSecret = [
    req.get('x-webhook-secret'),
    req.get('x-etrade-webhook-secret'),
    typeof req.body?.secret === 'string' ? req.body.secret : '',
    typeof req.query?.secret === 'string' ? req.query.secret : '',
  ].find((value) => typeof value === 'string' && value.trim().length > 0)?.trim() || '';

  if (expectedSecret && providedSecret !== expectedSecret) {
    return res.status(401).json({
      success: false,
      error: 'Webhook secret was missing or invalid.',
    });
  }

  const extraction = extractAutoAuthWebhookPayload({
    body: req.body,
    query: req.query,
    headers: {
      sessionId: req.get('x-etrade-session-id') || req.get('x-auto-auth-session-id') || req.get('x-session-id') || '',
    },
  });

  if (extraction.error) {
    return res.status(400).json({
      success: false,
      error: extraction.error,
    });
  }

  if (!extraction.code) {
    return res.status(400).json({
      success: false,
      error: 'Webhook payload did not contain a unique 6-digit E*TRADE code.',
    });
  }

  let resolvedSessionId = extraction.sessionId?.trim() || '';
  let session: AutoAuthSession | null = null;

  if (resolvedSessionId) {
    session = getAutoAuthSession(resolvedSessionId);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Webhook referenced an auto-auth session that was not found or already expired.',
        sessionId: resolvedSessionId,
      });
    }
  } else {
    if (activeAutoAuthSessions.size === 0) {
      return res.status(409).json({
        success: false,
        error: 'No active auto-auth session is currently waiting for a 2FA code.',
      });
    }

    if (activeAutoAuthSessions.size > 1) {
      return res.status(409).json({
        success: false,
        error: 'Multiple auto-auth sessions are active. Include sessionId in the webhook payload or x-etrade-session-id header.',
        sessionIds: Array.from(activeAutoAuthSessions.keys()),
      });
    }

    const activeSession = getOnlyActiveAutoAuthSession();
    if (!activeSession) {
      return res.status(409).json({
        success: false,
        error: 'No active auto-auth session is currently waiting for a 2FA code.',
      });
    }

    resolvedSessionId = activeSession.sessionId;
    session = activeSession.session;
  }

  try {
    const result = await completeAutoAuthSession(resolvedSessionId, session, extraction.code, 'webhook-delivered');
    res.json({
      success: true,
      message: 'Webhook 2FA code accepted and OAuth completed. Tokens saved to .env',
      sandbox: result.sandbox,
      sessionId: result.sessionId,
      codeSource: extraction.codeSource,
      sessionIdSource: extraction.sessionIdSource,
    });
  } catch (error: any) {
    console.error('Auto-auth webhook error:', error.message);
    if (error.response) {
      console.error('Auto-auth webhook error status:', error.response.status);
      console.error('Auto-auth webhook error data:', error.response.data);
    }
    res.status(500).json({
      success: false,
      error: error.message,
      sessionId: resolvedSessionId || null,
      canRetry: resolvedSessionId ? activeAutoAuthSessions.has(resolvedSessionId) : false,
    });
  }
});

async function extractVerifierCodeFromPage(page: Page, pageText?: string): Promise<string | null> {
  const visibleText = pageText ?? await getPageText(page);
  const fromVisibleText = extractVerifierCode(visibleText);
  if (fromVisibleText) {
    return fromVisibleText;
  }

  const invalidCodes = new Set(['TRADE', 'ETRADE', 'LOGIN', 'ERROR', 'CLICK', 'CLOSE', 'ENTER', 'PLACE']);
  const directFieldValueCode = await page.evaluate((invalidCodeList) => {
    const invalidSet = new Set(invalidCodeList);
    const inputs = Array.from(document.querySelectorAll('input, textarea'));

    for (const input of inputs) {
      const field = input as BrowserElementLike;
      const rawValue = (field.value || field.getAttribute('value') || '').trim().toUpperCase();
      if (/^[A-Z0-9]{5}$/.test(rawValue) && !invalidSet.has(rawValue)) {
        return rawValue;
      }
    }

    return null;
  }, Array.from(invalidCodes));

  if (directFieldValueCode) {
    console.log('Found verification code directly from an input field value.');
    return directFieldValueCode;
  }

  const fieldText = await page.evaluate(() => {
    const values: string[] = [];
    const elements = Array.from(document.querySelectorAll('input, textarea, [value], [aria-label], [placeholder]'));

    for (const element of elements) {
      const field = element as BrowserElementLike;
      const value = field.value || field.getAttribute('value') || '';
      const innerText = field.innerText || '';
      const ariaLabel = field.getAttribute('aria-label') || '';
      const placeholder = field.getAttribute('placeholder') || '';

      for (const candidate of [value, innerText, ariaLabel, placeholder]) {
        const trimmed = candidate.trim();
        if (trimmed) {
          values.push(trimmed);
        }
      }
    }

    return values.join('\n');
  });

  const combinedText = [visibleText, fieldText].filter(Boolean).join('\n');
  const fromFieldValues = extractVerifierCode(combinedText);
  if (fromFieldValues) {
    console.log('Found verification code using DOM field values.');
  }
  return fromFieldValues;
}

// Helper function to extract verifier code from page text
function extractVerifierCode(text: string): string | null {
  // E*TRADE verification codes are typically 5 alphanumeric characters
  // They appear after specific text like "Authorization Code" or "Verification Code"
  const invalidCodes = new Set(['TRADE', 'ETRADE', 'LOGIN', 'ERROR', 'CLICK', 'CLOSE', 'ENTER', 'PLACE']);

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  // First, try to find code after specific labels
  const labelPatterns = [
    /(?:authorization\s*code|verification\s*code|your\s*code\s*is)[:\s]+([A-Z0-9]{5})\b/i,
    /(?:authorization\s*code|verification\s*code|your\s*code\s*is)\s*$/i,
  ];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const pattern of labelPatterns) {
      const match = line.match(pattern);
      if (match?.[1]) {
        const code = match[1].toUpperCase();
        if (!invalidCodes.has(code)) {
          console.log(`Found verification code via label pattern: ${code}`);
          return code;
        }
      }

      if (pattern.source.includes('your\\s*code\\s*is') || pattern.source.includes('authorization\\s*code') || pattern.source.includes('verification\\s*code')) {
        const nextLine = lines[index + 1]?.match(/^([A-Z0-9]{5})\b/i)?.[1]?.toUpperCase();
        if (nextLine && !invalidCodes.has(nextLine)) {
          console.log(`Found verification code on following line: ${nextLine}`);
          return nextLine;
        }
      }
    }
  }

  // As a last resort, only accept mixed letter/number codes to avoid false positives.
  const codeMatches = text.match(/\b([A-Z0-9]{5})\b/g);
  if (codeMatches) {
    for (const code of codeMatches) {
      const upperCode = code.toUpperCase();
      if (invalidCodes.has(upperCode)) {
        continue;
      }

      const hasLetter = /[A-Z]/.test(upperCode);
      const hasNumber = /[0-9]/.test(upperCode);
      if (hasLetter && hasNumber) {
        console.log(`Found verification code (mixed): ${upperCode}`);
        return upperCode;
      }
    }
  }

  console.log('No valid verification code found in page text');
  return null;
}

export default router;
