import { Router } from 'express';
import OAuth from 'oauth-1.0a';
import crypto from 'crypto';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import puppeteer from 'puppeteer';

const router = Router();

const SANDBOX = process.env.ETRADE_SANDBOX === 'true';
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

// Clean up expired pending OAuth requests (older than 10 minutes)
setInterval(() => {
  const now = new Date();
  for (const [token, data] of pendingOAuth.entries()) {
    if (now.getTime() - data.createdAt.getTime() > 10 * 60 * 1000) {
      pendingOAuth.delete(token);
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

    const authUrl = `https://us.etrade.com/e/t/etws/authorize?key=${CONSUMER_KEY}&token=${token}`;

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
    process.env.ETRADE_ACCESS_TOKEN = accessToken;
    process.env.ETRADE_ACCESS_TOKEN_SECRET = accessTokenSecret;

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
    const { oauth_token, oauth_verifier } = req.body;

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
    process.env.ETRADE_ACCESS_TOKEN = accessToken;
    process.env.ETRADE_ACCESS_TOKEN_SECRET = accessTokenSecret;

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
  const hasTokens = !!(process.env.ETRADE_ACCESS_TOKEN && process.env.ETRADE_ACCESS_TOKEN_SECRET);

  res.json({
    authenticated: hasTokens,
    sandbox: SANDBOX,
    consumerKeySet: !!CONSUMER_KEY,
  });
});

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

// Automated OAuth flow using Puppeteer
// Uses E*TRADE credentials from env vars or request body
// Saves cookies to persist session across runs
router.post('/auto', async (req, res) => {
  const username = req.body.username || process.env.ETRADE_USERNAME;
  const password = req.body.password || process.env.ETRADE_PASSWORD;

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

  let browser;
  try {
    console.log(`Starting automated OAuth flow (headless: ${headless})...`);

    if (headless) {
      console.log('TIP: If you encounter verification issues, run with headless=false first to establish a session');
    }

    // Step 1: Get request token
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

    // Step 2: Launch browser and automate authorization
    const authUrl = `https://us.etrade.com/e/t/etws/authorize?key=${CONSUMER_KEY}&token=${requestToken}`;
    console.log('Launching browser for authorization...');

    browser = await puppeteer.launch({
      headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      defaultViewport: { width: 1280, height: 800 },
    });

    const page = await browser.newPage();

    // Set a realistic user agent
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Load saved cookies if available
    const hasCookies = await loadCookies(page);

    // Navigate to auth URL
    await page.goto(authUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    console.log('✓ Navigated to E*TRADE authorization page');

    // Check current page state
    const currentUrl = page.url();
    const pageContent = await page.content();
    const pageText = await page.evaluate(() => document.body.innerText);

    // Check if we're already on the authorization page (cookies worked)
    if (pageText.includes('Accept') && pageText.includes('authorize')) {
      console.log('✓ Session cookies valid - already on authorization page');
    }
    // Check if we hit identity verification
    else if (pageText.toLowerCase().includes('verify your identity') ||
             pageText.toLowerCase().includes('verification code') ||
             pageText.toLowerCase().includes('confirm your identity') ||
             pageText.toLowerCase().includes('security code') ||
             pageText.toLowerCase().includes('one-time code') ||
             pageText.toLowerCase().includes('two-factor') ||
             pageText.toLowerCase().includes('2fa')) {
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

        // Wait for user to complete verification (up to 5 minutes)
        await page.waitForFunction(
          () => document.body.innerText.includes('Accept') ||
                document.body.innerText.includes('authorize') ||
                document.body.innerText.includes('Verification Code') ||
                document.body.innerText.match(/[A-Z0-9]{5}/),
          { timeout: 300000 }
        ).catch(() => {});

        // Save cookies after verification
        await saveCookies(page);
      } else {
        throw new Error(errorMsg);
      }
    }
    // Need to log in
    else if (pageContent.includes('USER') || pageContent.includes('password') || pageContent.includes('Log On') || pageContent.includes('Sign In')) {
      console.log('Login form detected, entering credentials...');

      // Wait for login form
      await page.waitForSelector('input[name="USER"], input#USER, input[name="user_name"], input[type="text"]', { timeout: 10000 });

      // Try different possible selectors for username field
      const usernameInput = await page.$('input[name="USER"]')
        || await page.$('input#USER')
        || await page.$('input[name="user_name"]')
        || await page.$('input[type="text"][autocomplete="username"]');

      const passwordInput = await page.$('input[name="PASSWORD"]')
        || await page.$('input#PASSWORD')
        || await page.$('input[name="password"]')
        || await page.$('input[type="password"]');

      if (!usernameInput || !passwordInput) {
        await page.screenshot({ path: '/tmp/etrade_login_debug.png' });
        throw new Error('Could not find login form fields. Screenshot saved to /tmp/etrade_login_debug.png');
      }

      // Clear any existing values and type credentials
      await usernameInput.click({ clickCount: 3 });
      await usernameInput.type(username, { delay: 30 });
      await passwordInput.click({ clickCount: 3 });
      await passwordInput.type(password, { delay: 30 });
      console.log('✓ Filled login credentials');

      // Find and click login button
      const loginButton = await page.$('button[type="submit"]')
        || await page.$('input[type="submit"]')
        || await page.$('#logon_button')
        || await page.$('button.btn-primary')
        || await page.$('button[data-testid="login-button"]');

      if (loginButton) {
        await loginButton.click();
      } else {
        await page.keyboard.press('Enter');
      }

      // Wait for navigation after login
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      console.log('✓ Submitted login form');

      // Save cookies after successful login
      await saveCookies(page);

      // Re-check page state after login
      const postLoginText = await page.evaluate(() => document.body.innerText);

      // Check for verification after login
      if (postLoginText.toLowerCase().includes('verify your identity') ||
          postLoginText.toLowerCase().includes('verification code') ||
          postLoginText.toLowerCase().includes('security code')) {
        await page.screenshot({ path: '/tmp/etrade_post_login_verification.png' });

        if (!headless) {
          console.log('\n' + '='.repeat(60));
          console.log('IDENTITY VERIFICATION REQUIRED AFTER LOGIN');
          console.log('='.repeat(60));
          console.log('Please complete the verification in the browser window.');
          console.log('='.repeat(60) + '\n');

          // Wait for user to complete
          await page.waitForFunction(
            () => document.body.innerText.includes('Accept') ||
                  document.body.innerText.match(/[A-Z0-9]{5}/),
            { timeout: 300000 }
          ).catch(() => {});

          await saveCookies(page);
        } else {
          throw new Error('Identity verification required after login. Run with headless=false to complete verification. Screenshot: /tmp/etrade_post_login_verification.png');
        }
      }
    }

    // Now try to find and click the Accept button
    const finalPageText = await page.evaluate(() => document.body.innerText);

    // Check if we see the verification code directly (already authorized)
    let verifierCode = extractVerifierCode(finalPageText);

    if (!verifierCode) {
      // Look for the "Accept" button
      console.log('Looking for Accept/Authorize button...');

      const acceptClicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('input[type="submit"], input[type="button"], button, a.button'));
        for (const btn of buttons) {
          const text = ((btn as HTMLElement).innerText || (btn as HTMLInputElement).value || '').toLowerCase();
          if (text.includes('accept') || text.includes('authorize') || text.includes('allow') || text.includes('confirm')) {
            (btn as HTMLElement).click();
            return true;
          }
        }
        return false;
      });

      if (acceptClicked) {
        console.log('✓ Clicked Accept button');

        // Wait for the verification code page
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
        await saveCookies(page);

        // Extract verification code
        const codePageText = await page.evaluate(() => document.body.innerText);
        verifierCode = extractVerifierCode(codePageText);
      } else {
        await page.screenshot({ path: '/tmp/etrade_no_accept_button.png' });
        console.log('Could not find Accept button. Screenshot saved to /tmp/etrade_no_accept_button.png');

        // Maybe the code is already visible?
        verifierCode = extractVerifierCode(finalPageText);
      }
    }

    if (!verifierCode) {
      await page.screenshot({ path: '/tmp/etrade_no_code.png' });
      throw new Error(`Could not extract verification code. Screenshot saved to /tmp/etrade_no_code.png. You can manually complete: POST /api/auth/verify with {"oauth_token":"${requestToken}","oauth_verifier":"CODE"}`);
    }

    console.log(`✓ Got verification code: ${verifierCode}`);

    // Close browser
    await browser.close();
    browser = undefined;

    // Step 3: Exchange verifier for access token
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

    // Clean up pending OAuth
    pendingOAuth.delete(requestToken);

    // Save tokens
    updateEnvFile(accessToken, accessTokenSecret);
    process.env.ETRADE_ACCESS_TOKEN = accessToken;
    process.env.ETRADE_ACCESS_TOKEN_SECRET = accessTokenSecret;

    res.json({
      success: true,
      message: 'Automated OAuth completed successfully. Tokens saved to .env',
    });

  } catch (error: any) {
    console.error('Automated OAuth error:', error.message);

    // Make sure browser is closed on error
    if (browser) {
      await browser.close().catch(() => {});
    }

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Helper function to extract verifier code from page text
function extractVerifierCode(text: string): string | null {
  // Look for patterns like "Code: XXXXX" or standalone 5-6 char alphanumeric codes
  const patterns = [
    /(?:verification\s*code|code|verifier)[:\s]+([A-Z0-9]{5,6})/i,
    /\b([A-Z][A-Z0-9]{4})\b/,  // 5 chars starting with letter
    /\b([A-Z0-9]{5})\b/,       // Any 5 alphanumeric chars
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1] && match[1].length >= 5) {
      return match[1];
    }
  }

  return null;
}

export default router;
