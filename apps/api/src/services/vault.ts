/**
 * The secret vault: AES-256-GCM over the store's `secrets` table.
 *
 * Every user-supplied secret (API keys, MCP header values, OAuth tokens) lives here
 * as ciphertext. Plaintext exists only in process memory and is never returned by a
 * route, logged, or written to a trace. The ref is bound in as AAD, so a row copied
 * under another ref does not decrypt.
 *
 * A row that fails to decrypt (key file lost, ZEPHYR_VAULT_KEY changed, tampering)
 * is reported per entry as an error. It is never dropped or reset silently: the user
 * sees which secret needs re-entering.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { store } from '../store/index.js';
import type { Store, StoredSecret } from '../store/types.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
export const VAULT_KEY_CHANGED = 'Vault key changed; re-enter this key.';

export class VaultDecryptError extends Error {
  readonly code = 'VAULT_DECRYPT';
  constructor() {
    super(VAULT_KEY_CHANGED);
  }
}

export interface SecretEntry {
  ref: string;
  version: number;
  metadata?: Record<string, string>;
  updatedAt: string;
  plaintext?: string;
  error?: string;
}

type SecretStore = Pick<Store, 'putSecret' | 'listSecrets' | 'deleteSecret'>;

/**
 * ZEPHYR_VAULT_KEY wins. Otherwise a persisted deployment keeps one key file next to
 * its database; a non-persisted one uses a random key and writes nothing, so a
 * keyless clone never touches the disk.
 */
export async function loadVaultKey(options: {
  envKey?: string;
  keyPath: string;
  persist: boolean;
}): Promise<Buffer> {
  if (options.envKey) {
    const key = Buffer.from(options.envKey, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error('ZEPHYR_VAULT_KEY must be base64 for exactly 32 bytes.');
    }
    return key;
  }
  if (!options.persist) return randomBytes(KEY_BYTES);
  try {
    return await readKeyFile(options.keyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const key = randomBytes(KEY_BYTES);
  await mkdir(dirname(options.keyPath), { recursive: true });
  try {
    await writeFile(options.keyPath, key.toString('base64'), { flag: 'wx', mode: 0o600 });
    return key;
  } catch (error) {
    // Another process created it first: use theirs, never overwrite.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readKeyFile(options.keyPath);
    throw error;
  }
}

async function readKeyFile(path: string): Promise<Buffer> {
  const key = Buffer.from((await readFile(path, 'utf8')).trim(), 'base64');
  if (key.length !== KEY_BYTES) throw new Error('Vault key file ' + path + ' is not 32 bytes.');
  return key;
}

export class SecretVault {
  private readonly key: Promise<Buffer>;

  constructor(
    private readonly secrets: SecretStore,
    key: Buffer | Promise<Buffer>,
  ) {
    this.key = Promise.resolve(key);
    // Surface a bad key on first use, not as an unhandled rejection at import.
    this.key.catch(() => undefined);
  }

  async put(
    ref: string,
    kind: string,
    plaintext: string,
    metadata?: Record<string, string>,
  ): Promise<{ ref: string; version: number; updatedAt: string }> {
    const key = await this.key;
    const previous = (await this.secrets.listSecrets(kind)).find((row) => row.ref === ref);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(Buffer.from(ref, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const now = new Date().toISOString();
    const row: StoredSecret = {
      ref,
      kind,
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      version: (previous?.version ?? 0) + 1,
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata: { ...metadata } } : {}),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    await this.secrets.putSecret(row);
    return { ref, version: row.version, updatedAt: now };
  }

  async entries(kind: string): Promise<SecretEntry[]> {
    const key = await this.key;
    return (await this.secrets.listSecrets(kind)).map((row) => {
      const entry: SecretEntry = {
        ref: row.ref,
        version: row.version,
        updatedAt: row.updatedAt,
        ...(row.metadata ? { metadata: { ...row.metadata } } : {}),
      };
      try {
        entry.plaintext = decrypt(key, row);
      } catch {
        entry.error = VAULT_KEY_CHANGED;
      }
      return entry;
    });
  }

  remove(ref: string): Promise<boolean> {
    return this.secrets.deleteSecret(ref);
  }
}

function decrypt(key: Buffer, row: StoredSecret): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(row.iv, 'base64'));
  decipher.setAAD(Buffer.from(row.ref, 'utf8'));
  decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new VaultDecryptError();
  }
}

export const vault = new SecretVault(store, loadVaultKey(config.vault));
