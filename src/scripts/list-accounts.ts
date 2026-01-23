import { ETradeClient } from '../server/services/etrade-client.js';
import type { ETradeCredentials } from '../shared/types/index.js';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Load environment variables
dotenv.config();

interface AccountNickname {
  nickname: string;
  accountIdKey: string;
  accountId: string;
  accountName: string;
  accountType: string;
  accountStatus: string;
}

function log(message: string, data?: any) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  if (data !== undefined) {
    console.log(JSON.stringify(data, null, 2));
  }
}

async function listAccounts() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           E*TRADE Account Listing                          ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const isSandbox = process.env.ETRADE_SANDBOX === 'true';
  log(`Trading mode: ${isSandbox ? 'SANDBOX (Testing)' : 'PRODUCTION (Live Trading)'}`);

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

  if (!credentials.consumerKey || !credentials.consumerSecret) {
    log('ERROR: Missing consumer key or secret');
    process.exit(1);
  }

  if (!credentials.accessToken || !credentials.accessTokenSecret) {
    log('ERROR: Missing access tokens. Run oauth-flow.ts first.');
    process.exit(1);
  }

  const client = new ETradeClient(credentials, isSandbox);

  try {
    log('Fetching accounts from E*TRADE...');
    const accounts = await client.getAccounts();

    if (!accounts || accounts.length === 0) {
      log('ERROR: No accounts found');
      process.exit(1);
    }

    console.log('\n┌────────────────────────────────────────────────────────────────────────────────┐');
    console.log('│                           ACCOUNT DETAILS                                      │');
    console.log('└────────────────────────────────────────────────────────────────────────────────┘\n');

    const nicknames: AccountNickname[] = [];

    accounts.forEach((account: any, index: number) => {
      // Create nickname from last 4 digits of account ID
      const last4 = account.accountId.slice(-4);
      const nickname = last4;

      nicknames.push({
        nickname,
        accountIdKey: account.accountIdKey,
        accountId: account.accountId,
        accountName: account.accountName || account.accountDesc,
        accountType: account.accountType,
        accountStatus: account.accountStatus,
      });

      console.log(`  ┌──────────────────────────────────────────────────────────────────────────┐`);
      console.log(`  │  Account #${index + 1}: ${nickname}                                                          │`.slice(0, 79) + '│');
      console.log(`  ├──────────────────────────────────────────────────────────────────────────┤`);
      console.log(`  │  Nickname:         ${nickname.padEnd(52)}│`);
      console.log(`  │  Account ID:       ${account.accountId.padEnd(52)}│`);
      console.log(`  │  Account ID Key:   ${account.accountIdKey.padEnd(52)}│`);
      console.log(`  │  Name:             ${(account.accountName || account.accountDesc || 'N/A').padEnd(52)}│`);
      console.log(`  │  Description:      ${(account.accountDesc || 'N/A').padEnd(52)}│`);
      console.log(`  │  Type:             ${account.accountType.padEnd(52)}│`);
      console.log(`  │  Mode:             ${(account.accountMode || 'N/A').padEnd(52)}│`);
      console.log(`  │  Institution:      ${(account.institutionType || 'N/A').padEnd(52)}│`);
      console.log(`  │  Status:           ${account.accountStatus.padEnd(52)}│`);
      if (account.closedDate) {
        console.log(`  │  Closed Date:      ${new Date(account.closedDate).toISOString().padEnd(52)}│`);
      }
      console.log(`  └──────────────────────────────────────────────────────────────────────────┘`);
      console.log('');

      // Also print raw data for debugging
      log(`Raw account data for ${nickname}:`, account);
      console.log('');
    });

    // Print nickname summary
    console.log('\n┌────────────────────────────────────────────────────────────────────────────────┐');
    console.log('│                           NICKNAME SUMMARY                                     │');
    console.log('├────────────────────────────────────────────────────────────────────────────────┤');
    console.log('│  Use these nicknames when placing orders:                                      │');
    console.log('├────────────────────────────────────────────────────────────────────────────────┤');
    
    nicknames.forEach(n => {
      const statusIcon = n.accountStatus === 'ACTIVE' ? '✓' : '✗';
      const line = `  ${statusIcon} ${n.nickname}  →  ${n.accountName} (${n.accountType})`;
      console.log(`│${line.padEnd(79)}│`);
    });
    
    console.log('└────────────────────────────────────────────────────────────────────────────────┘');

    // Save nicknames to a JSON file
    const nicknamesPath = path.join(process.cwd(), '.account-nicknames.json');
    fs.writeFileSync(nicknamesPath, JSON.stringify(nicknames, null, 2));
    log(`\nSaved account nicknames to ${nicknamesPath}`);

    // Print usage example
    console.log('\n┌────────────────────────────────────────────────────────────────────────────────┐');
    console.log('│                           USAGE                                                │');
    console.log('├────────────────────────────────────────────────────────────────────────────────┤');
    console.log('│  To place an order using a nickname, run:                                      │');
    console.log('│                                                                                │');
    const activeAccount = nicknames.find(n => n.accountStatus === 'ACTIVE');
    if (activeAccount) {
      console.log(`│    ACCOUNT=${activeAccount.nickname} npx tsx src/scripts/buy-aapl.ts                          │`);
    }
    console.log('│                                                                                │');
    console.log('└────────────────────────────────────────────────────────────────────────────────┘');

    process.exit(0);

  } catch (error: any) {
    log('ERROR: ' + error.message);
    if (error.response) {
      log('Status: ' + error.response.status);
      log('Response:', error.response.data);
    }
    process.exit(1);
  }
}

// Export function to get account key by nickname
export async function getAccountKeyByNickname(nickname: string): Promise<string | null> {
  const nicknamesPath = path.join(process.cwd(), '.account-nicknames.json');
  
  if (!fs.existsSync(nicknamesPath)) {
    console.error('Account nicknames not found. Run list-accounts.ts first.');
    return null;
  }

  const nicknames: AccountNickname[] = JSON.parse(fs.readFileSync(nicknamesPath, 'utf-8'));
  const account = nicknames.find(n => n.nickname === nickname);
  
  if (!account) {
    console.error(`Account with nickname "${nickname}" not found.`);
    console.error('Available nicknames:', nicknames.map(n => n.nickname).join(', '));
    return null;
  }

  if (account.accountStatus !== 'ACTIVE') {
    console.error(`Account ${nickname} is not active (status: ${account.accountStatus})`);
    return null;
  }

  return account.accountIdKey;
}

// Run the script
listAccounts();
