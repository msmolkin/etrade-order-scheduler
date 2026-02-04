import { Router } from 'express';
import { ETradeClient } from '../services/etrade-client.js';

const router = Router();

function getETradeClient(): ETradeClient {
  const isSandbox = process.env.ETRADE_SANDBOX === 'true';

  const consumerKey = isSandbox
    ? process.env.ETRADE_SANDBOX_KEY!
    : process.env.ETRADE_CONSUMER_KEY!;
  const consumerSecret = isSandbox
    ? process.env.ETRADE_SANDBOX_SECRET!
    : process.env.ETRADE_CONSUMER_SECRET!;
  const accessToken = isSandbox
    ? process.env.ETRADE_SANDBOX_ACCESS_TOKEN
    : process.env.ETRADE_ACCESS_TOKEN;
  const accessTokenSecret = isSandbox
    ? process.env.ETRADE_SANDBOX_ACCESS_TOKEN_SECRET
    : process.env.ETRADE_ACCESS_TOKEN_SECRET;

  return new ETradeClient(
    {
      consumerKey,
      consumerSecret,
      accessToken,
      accessTokenSecret,
    },
    isSandbox
  );
}

router.get('/', async (req, res) => {
  const emptyResponse = () =>
    res.json({ accounts: [], defaultAccountIdKey: null });

  try {
    const client = getETradeClient();
    const accounts = await client.getAccounts();

    if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
      return emptyResponse();
    }

    const envNickname = process.env.ACCOUNT;

    const mapped = accounts.map((account: any) => {
      const nickname = String(account.accountId).slice(-4);
      const isDefaultFromEnv =
        !!envNickname && String(account.accountId).endsWith(String(envNickname));

      return {
        accountIdKey: account.accountIdKey,
        accountId: account.accountId,
        nickname,
        name: account.accountName || account.accountDesc || '',
        type: account.accountType,
        status: account.accountStatus,
        isDefaultFromEnv,
      };
    });

    res.json({
      accounts: mapped,
      defaultAccountIdKey:
        mapped.find((a) => a.isDefaultFromEnv)?.accountIdKey ??
        mapped.find((a) => a.status === 'ACTIVE')?.accountIdKey ??
        mapped[0]?.accountIdKey ??
        null,
    });
  } catch (error: any) {
    // Return empty list so the form still loads; user can enter Account ID manually
    const msg = error.message || String(error);
    console.warn('[GET /api/accounts]', msg);
    if (msg.includes('session expired') || msg.includes('invalid')) {
      console.warn('[GET /api/accounts] If you just updated .env with new tokens, restart the server (stop and run npm run dev again) so it picks them up.');
    }
    return emptyResponse();
  }
});

export default router;

