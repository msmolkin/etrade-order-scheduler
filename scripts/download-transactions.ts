import dotenv from "dotenv";
import { ETradeClient } from "../src/server/services/etrade-client.js";
import fs from "fs";
import path from "path";

dotenv.config();

const client = new ETradeClient(
  {
    consumerKey: process.env.ETRADE_CONSUMER_KEY!,
    consumerSecret: process.env.ETRADE_CONSUMER_SECRET!,
    accessToken: process.env.ETRADE_ACCESS_TOKEN!,
    accessTokenSecret: process.env.ETRADE_ACCESS_TOKEN_SECRET!,
  },
  false,
);

function formatDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}${dd}${d.getFullYear()}`;
}

async function downloadTransactions() {
  console.log("Fetching accounts...");
  const accounts = await client.getAccounts();
  console.log(`Found ${accounts.length} accounts`);

  const outputDir = "/home/michael/etrade-trade-placer/data/trade-history";
  fs.mkdirSync(outputDir, { recursive: true });

  const endDate = new Date();
  // API limit: 2 years back
  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - 2);
  startDate.setDate(startDate.getDate() + 1);

  console.log(`Date range: ${formatDate(startDate)} - ${formatDate(endDate)}`);

  for (const acct of accounts) {
    const key = (acct as any).accountIdKey;
    const desc = (acct as any).accountDesc || (acct as any).accountName || key;
    const mode = (acct as any).accountMode || "";
    console.log(`\n--- Account: ${desc} (${mode}) ---`);

    // Transactions
    const allTxns: any[] = [];
    let marker: string | undefined;
    let page = 0;
    while (true) {
      page++;
      const url = `/v1/accounts/${key}/transactions?startDate=${formatDate(startDate)}&endDate=${formatDate(endDate)}&count=50${marker ? `&marker=${marker}` : ""}`;
      console.log(`  Fetching transactions page ${page}...`);
      try {
        const fullUrl = `https://api.etrade.com${url}`;
        const headers = (client as any).getAuthHeader(fullUrl, "GET");
        const resp = await (client as any).httpClient.get(url, {
          headers: headers as any,
        });
        const data = resp.data?.TransactionListResponse ?? resp.data;
        const txns = data?.Transaction ?? [];
        const batch = Array.isArray(txns) ? txns : [txns];
        allTxns.push(...batch);
        console.log(
          `    Got ${batch.length} transactions (total: ${allTxns.length})`,
        );
        marker = data?.marker ?? data?.next;
        if (!marker || batch.length === 0) break;
      } catch (err: any) {
        const status = err?.response?.status;
        if (status === 204 || status === 404) {
          console.log("    No transactions found for this range.");
          break;
        }
        console.error(`    Error: ${err.message}`);
        break;
      }
    }

    // Orders (EXECUTED)
    const allOrders: any[] = [];
    marker = undefined;
    page = 0;
    while (true) {
      page++;
      const url = `/v1/accounts/${key}/orders?fromDate=${formatDate(startDate)}&toDate=${formatDate(endDate)}&status=EXECUTED&count=100${marker ? `&marker=${marker}` : ""}`;
      console.log(`  Fetching executed orders page ${page}...`);
      try {
        const fullUrl = `https://api.etrade.com${url}`;
        const headers = (client as any).getAuthHeader(fullUrl, "GET");
        const resp = await (client as any).httpClient.get(url, {
          headers: headers as any,
        });
        const data = resp.data?.OrdersResponse ?? resp.data;
        const orders = data?.Order ?? [];
        const batch = Array.isArray(orders) ? orders : [orders];
        allOrders.push(...batch);
        console.log(
          `    Got ${batch.length} orders (total: ${allOrders.length})`,
        );
        marker = data?.marker ?? data?.next;
        if (!marker || batch.length === 0) break;
      } catch (err: any) {
        const status = err?.response?.status;
        if (status === 204 || status === 404) {
          console.log("    No orders found for this range.");
          break;
        }
        console.error(`    Error: ${err.message}`);
        break;
      }
    }

    const safeName = desc.replace(/[^a-zA-Z0-9]/g, "_");
    if (allTxns.length > 0) {
      const txnFile = path.join(outputDir, `transactions_${safeName}.json`);
      fs.writeFileSync(txnFile, JSON.stringify(allTxns, null, 2));
      console.log(`  Saved ${allTxns.length} transactions to ${txnFile}`);
    }
    if (allOrders.length > 0) {
      const ordFile = path.join(outputDir, `orders_${safeName}.json`);
      fs.writeFileSync(ordFile, JSON.stringify(allOrders, null, 2));
      console.log(`  Saved ${allOrders.length} orders to ${ordFile}`);
    }
  }

  console.log("\n=== Download complete ===");
  console.log(`Files saved to ${outputDir}`);
}

downloadTransactions().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
