/**
 * Model keys: list + detail. Keys are written once and never read back; the server
 * returns only status and the last four characters.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  api,
  type CredentialConfiguration,
  type CredentialStatus,
  type VerifyResult,
} from '../../lib/api';
import { relativeTime, type StatusGlyph } from '../../lib/integrations';
import { Icon } from '../ui/Icon';
import { EnvImportDialog } from './EnvImportDialog';

export const KEY_META: Record<string, { name: string; usedBy: string; envVar: string }> = {
  anthropic: {
    name: 'Anthropic',
    usedBy: 'Agent text, Claude Code API mode',
    envVar: 'ANTHROPIC_API_KEY',
  },
  gemini: { name: 'Gemini', usedBy: 'Agent text', envVar: 'GEMINI_API_KEY' },
  jev: { name: 'Jev / AI Gateway', usedBy: 'Typed decisions', envVar: 'AI_GATEWAY_API_KEY' },
  browserbase: { name: 'Browserbase', usedBy: 'Browser sessions', envVar: 'BROWSERBASE_API_KEY' },
  browserless: { name: 'Browserless', usedBy: 'Browser sessions', envVar: 'BROWSERLESS_API_KEY' },
  tavily: { name: 'Tavily', usedBy: 'Web search', envVar: 'TAVILY_API_KEY' },
};

function glyphFor(status: CredentialStatus): StatusGlyph {
  if (status.error) return 'error';
  return status.configured ? 'done' : 'planned';
}

export function StatusMark({ glyph }: { glyph: StatusGlyph }) {
  return <span className={'status-mark status-mark--' + glyph} aria-hidden="true" />;
}

export function KeysCategory({
  selectedId,
  onChange,
}: {
  selectedId?: string;
  onChange: () => void;
}) {
  const [config, setConfig] = useState<CredentialConfiguration>();
  const [loadError, setLoadError] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [notice, setNotice] = useState('');

  const reload = useCallback(async () => {
    try {
      setConfig(await api.credentials());
      setLoadError('');
    } catch (issue) {
      setLoadError(issue instanceof Error ? issue.message : 'Key status unavailable.');
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const changed = async (message?: string) => {
    setNotice(message ?? '');
    await reload();
    onChange();
  };

  const providers = config?.providers ?? [];
  const selected = providers.find((p) => p.providerId === selectedId) ?? providers[0];

  return (
    <div className="integration-split">
      <section className="integration-list" aria-labelledby="keys-list-title">
        <header className="integration-list-head">
          <h2 id="keys-list-title">Model keys</h2>
          <button className="secondary-button" type="button" onClick={() => setImportOpen(true)}>
            <Icon name="file" size={14} />
            Import .env
          </button>
        </header>
        {loadError && (
          <p className="error-note" role="alert">
            {loadError}{' '}
            <button className="text-link" onClick={() => void reload()}>
              Retry
            </button>
          </p>
        )}
        {notice && (
          <p className="success-note" role="status">
            {notice}
          </p>
        )}
        <ul className="integration-rows">
          {providers.map((status) => {
            const meta = KEY_META[status.providerId];
            const isSelected = status.providerId === selected?.providerId;
            return (
              <li key={status.providerId}>
                <Link
                  to={'/integrations/keys/' + status.providerId}
                  className={
                    'integration-row integration-row--' +
                    glyphFor(status) +
                    (isSelected ? ' is-selected' : '')
                  }
                  aria-current={isSelected ? 'true' : undefined}
                >
                  <StatusMark glyph={glyphFor(status)} />
                  <span className="integration-row-name">{meta?.name ?? status.providerId}</span>
                  <span className="integration-row-detail">
                    {status.error
                      ? 'Re-enter'
                      : status.configured
                        ? '…' + (status.last4 ?? '—')
                        : 'Not set'}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
        {config && (
          <p className="inline-note">
            {config.lifetime === 'persisted'
              ? 'Keys are encrypted on this machine and survive restarts.'
              : 'Keys last until the API restarts. Set PERSIST_TO_DISK=true to keep them.'}
          </p>
        )}
      </section>
      {selected && config && (
        <KeyDetail
          key={selected.providerId}
          status={selected}
          config={config}
          onChanged={(message) => void changed(message)}
        />
      )}
      <EnvImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(count) =>
          void changed(count === 1 ? 'Imported 1 key.' : 'Imported ' + count + ' keys.')
        }
      />
    </div>
  );
}

function KeyDetail({
  status,
  config,
  onChanged,
}: {
  status: CredentialStatus;
  config: CredentialConfiguration;
  onChanged: (message?: string) => void;
}) {
  const navigate = useNavigate();
  const meta = KEY_META[status.providerId];
  const name = meta?.name ?? status.providerId;
  const [secret, setSecret] = useState('');
  const [projectId, setProjectId] = useState(status.metadata?.projectId ?? '');
  const [busy, setBusy] = useState<'save' | 'verify' | 'remove' | null>(null);
  const [error, setError] = useState('');
  const [verify, setVerify] = useState<VerifyResult>();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const operatorBilled = status.source === 'operator';

  const run = async (action: 'save' | 'verify' | 'remove', work: () => Promise<void>) => {
    setBusy(action);
    setError('');
    try {
      await work();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'That did not work. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    void run('save', async () => {
      await api.saveCredential(
        status.providerId,
        secret.trim(),
        status.providerId === 'browserbase' && projectId.trim()
          ? { projectId: projectId.trim() }
          : undefined,
      );
      setSecret('');
      setVerify(undefined);
      onChanged(name + ' key saved.');
    });
  };

  return (
    <section className="integration-detail" aria-labelledby="key-detail-title">
      <header className="integration-detail-head">
        <h2 id="key-detail-title">{name}</h2>
        <span
          className={
            'status-chip ' +
            (status.error
              ? 'status-chip--bad'
              : status.configured
                ? 'status-chip--good'
                : 'status-chip--neutral')
          }
        >
          {status.error ? 'Unreadable' : status.configured ? 'Connected' : 'Not set'}
        </span>
      </header>

      {status.error && (
        <p className="error-note" role="alert">
          {status.error}
        </p>
      )}

      <dl className="integration-facts">
        <dt>Billed to</dt>
        <dd>{operatorBilled ? 'Operator (.env)' : 'You'}</dd>
        <dt>Key</dt>
        <dd>{status.configured ? 'ending in ' + (status.last4 ?? '—') : '—'}</dd>
        <dt>Updated</dt>
        <dd>{relativeTime(status.updatedAt)}</dd>
        <dt>Used by</dt>
        <dd>{meta?.usedBy ?? '—'}</dd>
        <dt>Env variable</dt>
        <dd>{meta?.envVar ?? '—'}</dd>
      </dl>

      {operatorBilled && (
        <p className="notice">
          This provider is billed to the operator key in .env. A key you save here is kept, and is
          used once user billing is turned on for{' '}
          {status.purpose === 'browser' ? 'browsers' : 'models'}.
        </p>
      )}

      <form className="integration-form" onSubmit={save}>
        <div className="field">
          <label htmlFor="key-secret">{status.configured ? 'Replace key' : 'API key'}</label>
          <input
            id="key-secret"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={secret}
            placeholder={status.configured ? '…' + (status.last4 ?? '') : 'Paste your key'}
            onChange={(event) => setSecret(event.target.value)}
          />
        </div>
        {status.providerId === 'browserbase' && (
          <div className="field">
            <label htmlFor="key-project">Project ID</label>
            <input
              id="key-project"
              autoComplete="off"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            />
          </div>
        )}
        <div className="integration-actions">
          <button
            className="primary-button"
            type="submit"
            disabled={busy !== null || !secret.trim()}
          >
            {busy === 'save' ? 'Saving…' : 'Save key'}
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={busy !== null || !status.configured}
            onClick={() =>
              void run('verify', async () =>
                setVerify(await api.verifyCredential(status.providerId)),
              )
            }
          >
            {busy === 'verify' ? 'Checking…' : 'Verify'}
          </button>
        </div>
      </form>

      {verify && (
        <p
          className={
            verify.ok === false ? 'error-note' : verify.ok ? 'success-note' : 'inline-note'
          }
          role="status"
        >
          {verify.detail}
        </p>
      )}
      {error && (
        <p className="error-note" role="alert">
          {error}
        </p>
      )}

      {status.configured && !operatorBilled && (
        <div className="integration-danger">
          {confirmRemove ? (
            <>
              <span>Remove the {name} key? Active runs that use it will stop.</span>
              <button
                className="danger-button"
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  void run('remove', async () => {
                    await api.removeCredential(status.providerId);
                    setConfirmRemove(false);
                    onChanged(name + ' key removed.');
                    navigate('/integrations/keys/' + status.providerId, { replace: true });
                  })
                }
              >
                {busy === 'remove' ? 'Removing…' : 'Remove'}
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => setConfirmRemove(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <button className="danger-button" type="button" onClick={() => setConfirmRemove(true)}>
              Remove key
            </button>
          )}
        </div>
      )}
    </section>
  );
}
