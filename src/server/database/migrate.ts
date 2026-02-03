/**
 * Database migrations = versioned changes to the database schema (tables, columns, indexes).
 * This project uses a single schema file (schema.sql) with CREATE TABLE IF NOT EXISTS,
 * so "migration" here means: apply that schema once so tables exist.
 *
 * npm run db:migrate = run this script: connect to the DB and execute schema.sql.
 * The server also runs the same schema automatically on startup (see runSchema in client.ts).
 */
import { runSchema } from './client.js';

async function migrate() {
  console.log('Running database migration...');
  const result = await runSchema();
  if (result.ok) {
    console.log('✓ Database migration completed successfully');
    process.exit(0);
  } else {
    console.error('✗ Migration failed:', result.error);
    process.exit(1);
  }
}

migrate();
