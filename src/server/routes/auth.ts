import { Router } from 'express';
import OAuth from 'oauth-1.0a';
import crypto from 'crypto';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

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

export default router;
