import dotenv from 'dotenv';
import { query } from '../server/database/client.js';

dotenv.config();

const TARGET_EXPIRATION = '2026-02-06'; // YYYY-MM-DD

async function updateOptionOrdersExpiration() {
  const targetDate = new Date(Date.UTC(2026, 1, 6, 12, 0, 0, 0)); // Feb 6, 2026 noon UTC

  const list = await query<{ id: string; symbol: string; expiration_date: string | null }>(
    `SELECT id, symbol, expiration_date FROM orders WHERE security_type = 'OPTION' ORDER BY created_at DESC`
  );

  console.log(`Found ${list.rows.length} option order(s).\n`);

  if (list.rows.length === 0) {
    console.log('Nothing to update.');
    return;
  }

  for (const row of list.rows) {
    const current = row.expiration_date
      ? new Date(row.expiration_date).toISOString().slice(0, 10)
      : null;
    console.log(`Order ${row.id} (${row.symbol}): expiration ${current ?? 'null'} -> ${TARGET_EXPIRATION}`);
  }

  const updated = await query(
    `UPDATE orders SET expiration_date = $1 WHERE security_type = 'OPTION' RETURNING id, symbol`,
    [targetDate]
  );

  console.log(`\nUpdated ${updated.rowCount} order(s) to expiration ${TARGET_EXPIRATION}.`);
  process.exit(0);
}

updateOptionOrdersExpiration().catch((err) => {
  console.error(err);
  process.exit(1);
});
