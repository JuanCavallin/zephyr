import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretVault, loadVaultKey } from '../src/services/vault.js';
import { createMemoryStore } from '../src/store/memory.js';
import { createSqliteStore } from '../src/store/sqlite.js';
import type { Store } from '../src/store/types.js';

const REF = 'vault:credential/u/anthropic';

async function roundTrip(store: Store): Promise<void> {
  const key = randomBytes(32);
  const vault = new SecretVault(store, key);
  const first = await vault.put(REF, 'credential', 'sk-1', { projectId: 'p' });
  assert.equal(first.version, 1);
  let entries = await vault.entries('credential');
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.plaintext, 'sk-1');
  assert.equal(entries[0]!.version, 1);
  assert.deepEqual(entries[0]!.metadata, { projectId: 'p' });

  const second = await vault.put(REF, 'credential', 'sk-2');
  assert.equal(second.version, 2, 'rewriting a ref bumps its version');
  entries = await vault.entries('credential');
  assert.equal(entries[0]!.plaintext, 'sk-2');
  assert.deepEqual(await vault.entries('other-kind'), [], 'entries are filtered by kind');

  const rows = JSON.stringify(await store.listSecrets());
  assert.ok(!rows.includes('sk-2') && !rows.includes('sk-1'), 'ciphertext only at rest');

  // Tamper: one flipped auth-tag byte must fail closed, per secret, without throwing.
  const [row] = await store.listSecrets('credential');
  const tag = Buffer.from(row!.tag, 'base64');
  tag[0] = tag[0]! ^ 0xff;
  await store.putSecret({ ...row!, tag: tag.toString('base64') });
  const tampered = await vault.entries('credential');
  assert.equal(tampered[0]!.plaintext, undefined);
  assert.match(tampered[0]!.error ?? '', /Vault key changed/);

  // A different key reads every secret as broken, never as garbage.
  await vault.put(REF, 'credential', 'sk-3');
  const wrong = new SecretVault(store, randomBytes(32));
  const unreadable = await wrong.entries('credential');
  assert.equal(unreadable[0]!.plaintext, undefined);
  assert.match(unreadable[0]!.error ?? '', /Vault key changed/);

  // Secrets are bound to their ref: a row copied under another ref does not decrypt.
  const [current] = await store.listSecrets('credential');
  await store.putSecret({ ...current!, ref: 'vault:credential/u/gemini' });
  const moved = (await vault.entries('credential')).find(
    (entry) => entry.ref === 'vault:credential/u/gemini',
  );
  assert.match(moved?.error ?? '', /Vault key changed/);

  assert.equal(await vault.remove(REF), true);
  assert.equal(await vault.remove(REF), false);
}

await roundTrip(createMemoryStore());

const directory = await mkdtemp(join(tmpdir(), 'zephyr-vault-check-'));
try {
  const sqlite = createSqliteStore(join(directory, 'store.sqlite'));
  await sqlite.hydrate();
  await roundTrip(sqlite);
  sqlite.close();

  await assert.rejects(
    loadVaultKey({ envKey: randomBytes(31).toString('base64'), keyPath: 'unused', persist: true }),
    /32 bytes/,
  );
  const fromEnv = randomBytes(32);
  assert.ok(
    (
      await loadVaultKey({ envKey: fromEnv.toString('base64'), keyPath: 'x', persist: true })
    ).equals(fromEnv),
  );

  const ephemeralPath = join(directory, 'ephemeral.key');
  const ephemeral = await loadVaultKey({ keyPath: ephemeralPath, persist: false });
  assert.equal(ephemeral.length, 32);
  assert.ok(!existsSync(ephemeralPath), 'a non-persisted clone writes no key file');

  const keyPath = join(directory, 'nested', 'vault.key');
  const created = await loadVaultKey({ keyPath, persist: true });
  assert.equal(created.length, 32);
  assert.ok(existsSync(keyPath));
  const again = await loadVaultKey({ keyPath, persist: true });
  assert.ok(again.equals(created), 'the key file is created once and reused');
  assert.equal((await readFile(keyPath)).length > 0, true);
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('vault check passed');
