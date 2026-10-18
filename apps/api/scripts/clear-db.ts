/**
 * Clear the durable SQLite store: deletes the database file and its WAL/SHM
 * sidecars. The schema is recreated on the next API start.
 *
 * Stop the API first — a running server holds the file open.
 *
 *   pnpm --filter @htn/api clear-db
 */

import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

// Same default as config.ts (SQLITE_PATH), resolved against apps/api.
const base = resolve(process.env.SQLITE_PATH ?? '../../.data/agentos.sqlite');

let removed = 0;
for (const file of [base, `${base}-wal`, `${base}-shm`]) {
  if (!existsSync(file)) continue;
  try {
    rmSync(file);
    removed++;
    console.log(`removed ${file}`);
  } catch (err) {
    console.error(`could not remove ${file}: ${(err as Error).message}`);
    console.error('Is the API still running? Stop it and try again.');
    process.exit(1);
  }
}

console.log(removed === 0 ? `nothing to clear (${base} does not exist)` : 'database cleared');
