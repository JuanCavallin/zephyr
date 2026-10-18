import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

export type CredentialPurpose = 'model' | 'decision' | 'browser' | 'search';
export type CredentialSource = 'operator' | 'user';
export const LOCAL_PRINCIPAL = 'local-user';
export const CREDENTIAL_PROVIDERS = {
  gemini: 'model',
  anthropic: 'model',
  jev: 'decision',
  browserbase: 'browser',
  browserless: 'browser',
  tavily: 'search',
} as const satisfies Record<string, CredentialPurpose>;
export type CredentialProvider = keyof typeof CREDENTIAL_PROVIDERS;

export interface CredentialContext {
  runId: string;
  providerId: string;
  purpose: CredentialPurpose;
  principalId?: string;
}

/** Internal only. Never serialize this object to HTTP, traces, or session state. */
export interface ResolvedCredential {
  reference: string;
  version: number;
  secret: string;
  source: CredentialSource;
  metadata?: { projectId?: string };
}

export interface CredentialStatus {
  providerId: CredentialProvider;
  purpose: CredentialPurpose;
  source: CredentialSource;
  configured: boolean;
  version?: number;
  metadata?: { projectId?: string };
}

export class CredentialRequiredError extends Error {
  readonly code = 'CREDENTIAL_REQUIRED';
  constructor(
    readonly providerId: string,
    source: CredentialSource = 'user',
  ) {
    super(
      source === 'user'
        ? 'User credentials are required for ' + providerId + '. Configure them in Connections.'
        : 'Operator credentials are required for ' +
            providerId +
            '. Configure the provider key in .env or select user funding.',
    );
  }
}

export interface CredentialStoreOptions {
  source: CredentialSource;
  browserSource?: CredentialSource;
  operator?: Partial<Record<CredentialProvider, { secret?: string; projectId?: string }>>;
}

/** Single-user local MVP. All secrets and run pins disappear on process restart. */
export class CredentialStore {
  readonly source: CredentialSource;
  readonly browserSource: CredentialSource;
  private readonly user = new Map<string, ResolvedCredential>();
  private readonly principals = new Map<string, string>();
  private readonly pins = new Map<string, { reference: string; version: number }>();
  private readonly listeners = new Set<
    (reference: string, providerId: CredentialProvider) => void
  >();

  constructor(private readonly options: CredentialStoreOptions) {
    this.source = options.source;
    this.browserSource = options.browserSource ?? options.source;
  }

  bindRun(runId: string, principalId = LOCAL_PRINCIPAL): void {
    const current = this.principals.get(runId);
    if (current && current !== principalId) throw new Error('Run belongs to another principal.');
    this.principals.set(runId, principalId);
  }

  principalForRun(runId: string): string {
    // The whole local deployment has one principal; this is not hosted authentication.
    return this.principals.get(runId) ?? LOCAL_PRINCIPAL;
  }

  sourceFor(purpose: CredentialPurpose): CredentialSource {
    return purpose === 'browser' ? this.browserSource : this.source;
  }

  onInvalidate(listener: (reference: string, providerId: CredentialProvider) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  put(
    principalId: string,
    providerId: CredentialProvider,
    secret: string,
    metadata?: { projectId?: string },
  ): CredentialStatus {
    const trimmed = secret.trim();
    if (!trimmed || trimmed.length > 8192 || /[\r\n\0]/.test(trimmed)) {
      throw new Error('Provide a non-empty API key with no line breaks.');
    }
    const key = principalId + ':' + providerId;
    const previous = this.user.get(key);
    this.user.set(key, {
      reference: randomUUID(),
      version: (previous?.version ?? 0) + 1,
      secret: trimmed,
      source: 'user',
      metadata: metadata?.projectId ? { projectId: metadata.projectId } : undefined,
    });
    if (previous) this.invalidate(previous.reference, providerId);
    return this.status(principalId, providerId);
  }

  remove(principalId: string, providerId: CredentialProvider): CredentialStatus {
    const key = principalId + ':' + providerId;
    const previous = this.user.get(key);
    this.user.delete(key);
    if (previous) this.invalidate(previous.reference, providerId);
    return this.status(principalId, providerId);
  }

  statuses(principalId: string): CredentialStatus[] {
    return (Object.keys(CREDENTIAL_PROVIDERS) as CredentialProvider[]).map((provider) =>
      this.status(principalId, provider),
    );
  }

  available(context: CredentialContext): boolean {
    const value = this.lookup(context);
    if (!value) return false;
    const pin = this.pins.get(this.pinKey(context));
    return !pin || (pin.reference === value.reference && pin.version === value.version);
  }

  async resolve(context: CredentialContext): Promise<ResolvedCredential | null> {
    const value = this.lookup(context);
    if (!value) return null;
    const key = this.pinKey(context);
    const pinned = this.pins.get(key);
    if (pinned && (pinned.reference !== value.reference || pinned.version !== value.version)) {
      throw new Error(
        'Credential changed during this run; start a new run to use the replacement.',
      );
    }
    this.pins.set(key, { reference: value.reference, version: value.version });
    return { ...value, metadata: value.metadata ? { ...value.metadata } : undefined };
  }

  async require(context: CredentialContext): Promise<ResolvedCredential> {
    const value = await this.resolve(context);
    if (!value)
      throw new CredentialRequiredError(context.providerId, this.sourceFor(context.purpose));
    return value;
  }

  assertCurrent(reference: string, context: CredentialContext): void {
    if (this.lookup(context)?.reference !== reference)
      throw new Error('Credential expired or was removed.');
  }

  private status(principalId: string, providerId: CredentialProvider): CredentialStatus {
    const purpose = CREDENTIAL_PROVIDERS[providerId];
    const source = this.sourceFor(purpose);
    const value =
      source === 'user'
        ? this.user.get(principalId + ':' + providerId)
        : this.operatorCredential(providerId);
    return {
      providerId,
      purpose,
      source,
      configured: Boolean(value),
      version: value?.version,
      metadata: value?.metadata,
    };
  }

  private lookup(context: CredentialContext): ResolvedCredential | undefined {
    if (!(context.providerId in CREDENTIAL_PROVIDERS)) return undefined;
    const provider = context.providerId as CredentialProvider;
    if (CREDENTIAL_PROVIDERS[provider] !== context.purpose) return undefined;
    const principal = this.principalForRun(context.runId);
    if (context.principalId && principal !== context.principalId)
      throw new Error('Credential principal does not own this run.');
    return this.sourceFor(context.purpose) === 'user'
      ? this.user.get(principal + ':' + provider)
      : this.operatorCredential(provider);
  }

  private operatorCredential(provider: CredentialProvider): ResolvedCredential | undefined {
    const configured = this.options.operator?.[provider];
    if (!configured?.secret) return undefined;
    return {
      reference: 'operator:' + provider,
      version: 1,
      secret: configured.secret,
      source: 'operator',
      metadata: configured.projectId ? { projectId: configured.projectId } : undefined,
    };
  }

  private pinKey(context: CredentialContext): string {
    return (
      this.principalForRun(context.runId) +
      ':' +
      context.runId +
      ':' +
      context.providerId +
      ':' +
      context.purpose
    );
  }

  private invalidate(reference: string, provider: CredentialProvider): void {
    for (const listener of this.listeners) listener(reference, provider);
  }
}

export const credentials = new CredentialStore({
  source: config.credentials.source,
  browserSource: config.credentials.browserSource,
  operator: {
    gemini: { secret: config.providers.gemini.apiKey },
    anthropic: { secret: config.providers.anthropic.apiKey },
    jev: { secret: config.providers.jev.apiKey },
    browserbase: {
      secret: config.providers.browserbase.apiKey,
      projectId: config.providers.browserbase.projectId,
    },
    browserless: { secret: config.providers.browserless.apiKey },
    tavily: { secret: config.webSearch.apiKey },
  },
});
