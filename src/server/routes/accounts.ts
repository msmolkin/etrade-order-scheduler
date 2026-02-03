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
  try {
    const client = getETradeClient();
    const accounts = await client.getAccounts();

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
    res.status(500).json({ error: error.message || 'Failed to load accounts' });
  }
});

export default router;

