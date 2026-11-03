/**
 * One-command export and delete of the learning profile (docs/cacp-08-learning-loop.md).
 *
 *   pnpm learning:export [out.json]   the whole profile as JSON, to stdout or a file
 *   pnpm learning:delete --yes        forget every signal and learned entry
 *
 * The profile is `ZEPHYR_PROFILE_DB`, else `~/.zephyr/profile.db`. A missing profile is
 * never created by either command: export prints an empty profile, delete does nothing.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { defaultProfilePath, ProfileStore } from '../src/core/learning/profileStore.js';

const [command, ...args] = process.argv.slice(2);
const path = defaultProfilePath();
const exists = existsSync(path);

function open(): ProfileStore {
  return new ProfileStore(exists ? path : ':memory:');
}

if (command === 'export') {
  const store = open();
  try {
    const json = JSON.stringify(store.exportAll(), null, 2) + '\n';
    const out = args[0];
    if (out) {
      writeFileSync(out, json);
      console.error(`exported ${exists ? path : '(no profile yet)'} -> ${out}`);
    } else {
      process.stdout.write(json);
    }
  } finally {
    store.close();
  }
} else if (command === 'delete') {
  if (!args.includes('--yes')) {
    console.error(`this forgets everything Zephyr learned in ${path}. Re-run with --yes to confirm.`);
    process.exit(2);
  }
  if (!exists) {
    console.error(`no profile at ${path}; nothing to delete`);
  } else {
    const store = open();
    try {
      const removed = store.deleteAll();
      console.error(`deleted ${removed.signals} signals and ${removed.entries} learned entries from ${path}`);
    } finally {
      store.close();
    }
  }
} else {
  console.error('usage: learning-profile export [out.json] | delete --yes');
  process.exit(2);
}
