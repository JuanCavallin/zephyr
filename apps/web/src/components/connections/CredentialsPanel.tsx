import { useEffect, useState } from 'react';
import { api, type CredentialConfiguration } from '../../lib/api';
import { Icon } from '../ui/Icon';

const PROVIDERS = [
  ['gemini', 'Gemini', 'Generative model'],
  ['anthropic', 'Anthropic', 'Generative model'],
  ['jev', 'Jev / AI Gateway', 'Typed decisions'],
  ['browserbase', 'Browserbase', 'Deprecated browser compatibility'],
  ['browserless', 'Browserless', 'Optional cloud browser'],
  ['tavily', 'Tavily', 'Optional web search'],
] as const;

export function CredentialsPanel() {
  const [configuration, setConfiguration] = useState<CredentialConfiguration>();
  const [provider, setProvider] = useState<string>('gemini');
  const [secret, setSecret] = useState('');
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const reload = async () => {
    setError('');
    try {
      setConfiguration(await api.credentials());
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Credential status unavailable.');
    }
  };
  useEffect(() => {
    void reload();
  }, []);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.saveCredential(
        provider,
        secret.trim(),
        provider === 'browserbase' ? { projectId: projectId.trim() } : undefined,
      );
      setSecret('');
      setProjectId('');
      const source = ['browserbase', 'browserless'].includes(provider)
        ? configuration?.browserSource
        : configuration?.source;
      setNotice(
        source === 'operator'
          ? 'Your key is saved for this local process. This deployment still uses operator billing for this provider; your key becomes active when user funding is enabled.'
          : 'Credential saved for this local session.',
      );
      await reload();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Credential could not be saved.');
    } finally {
      setBusy(false);
    }
  };
  const remove = async (providerId: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.removeCredential(providerId);
      setNotice('Your saved credential was removed. Active runs may need to reconnect.');
      await reload();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Credential could not be removed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="surface-section credential-section" aria-labelledby="credentials-title">
      <header>
        <h2 id="credentials-title">Your API keys</h2>
        <button
          className="icon-button"
          aria-label="Refresh credential status"
          disabled={busy}
          onClick={() => void reload()}
        >
          <Icon name="replay" size={15} />
        </button>
      </header>
      <p className="inline-note">
        Use your own accounts for models, browser sessions, and search. Model keys do not cover
        browser or connected-app usage. Local Ollama needs no model API key.
      </p>
      {configuration && (
        <p className="inline-note">
          Model credential source: <strong>{configuration.source}</strong> · Browser credential
          source: <strong>{configuration.browserSource}</strong>. Keys are held by this local API
          process and disappear when it restarts.
        </p>
      )}
      <div className="credential-status-grid">
        {configuration?.providers.map((item) => (
          <div className="credential-status" key={item.providerId}>
            <span>
              <strong>
                {PROVIDERS.find(([id]) => id === item.providerId)?.[1] ?? item.providerId}
              </strong>
              <small>{item.purpose}</small>
            </span>
            <span className={'status-chip status-chip--' + (item.configured ? 'good' : 'neutral')}>
              {item.configured ? item.source + ' configured' : 'not configured'}
            </span>
            {item.source === 'user' && item.configured && (
              <button
                className="icon-button"
                disabled={busy}
                aria-label={'Remove your ' + item.providerId + ' key'}
                onClick={() => void remove(item.providerId)}
              >
                <Icon name="close" size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
      <form className="credential-form" onSubmit={(event) => void save(event)}>
        <div className="field">
          <label htmlFor="credential-provider">Provider</label>
          <select
            id="credential-provider"
            disabled={busy}
            value={provider}
            onChange={(event) => {
              setProvider(event.target.value);
              setSecret('');
              setProjectId('');
              setNotice('');
            }}
          >
            {PROVIDERS.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="credential-secret">API key</label>
          <input
            id="credential-secret"
            type="password"
            autoComplete="off"
            spellCheck={false}
            required
            value={secret}
            disabled={busy}
            onChange={(event) => setSecret(event.target.value)}
            placeholder="Paste your key"
          />
        </div>
        {provider === 'browserbase' && (
          <div className="field">
            <label htmlFor="credential-project">Browserbase project ID</label>
            <input
              id="credential-project"
              autoComplete="off"
              required
              value={projectId}
              disabled={busy}
              onChange={(event) => setProjectId(event.target.value)}
            />
          </div>
        )}
        <button className="primary-button" type="submit" disabled={busy || !secret.trim()}>
          {busy ? 'Saving…' : 'Save key'}
        </button>
      </form>
      <p className="inline-note">
        Saved values are never displayed again. Connected-app OAuth accounts are managed separately
        below.
      </p>
      {notice && (
        <p className="success-note" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error-note" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
