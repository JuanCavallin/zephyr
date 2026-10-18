/**
 * Truthful connections screen: what AgentOS is actually wired to, not what a demo
 * script claims. Every fact here comes straight from a live route response — no
 * credential status never returns secret values. User API-key inputs live only
 * in the setup form until saved to the local API process. See docs/frontend-handoff.md.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Capability, McpConnection, ProviderId, ProviderStatus } from '@htn/shared';
import { api, ApiError, type ToolCatalogEntry } from '../lib/api';
import { Icon } from '../components/ui/Icon';
import { CredentialsPanel } from '../components/connections/CredentialsPanel';
import { SupervisionExamples } from '../components/actions/SupervisionExamples';

type ComposioTool = { name: string; toolkit?: string; version?: string; connected: boolean };

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/** Local-only fetch/reload hook. No caching beyond this page's lifetime. */
function useAsync<T>(fn: () => Promise<T>) {
  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: true, error: null });
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(() => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    fnRef
      .current()
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((err) =>
        setState({
          data: null,
          loading: false,
          error: err instanceof Error ? err.message : 'Request failed.',
        }),
      );
  }, []);

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { ...state, reload };
}

function Chip({
  tone,
  children,
}: {
  tone: 'good' | 'warn' | 'bad' | 'neutral';
  children: React.ReactNode;
}) {
  return <span className={'status-chip status-chip--' + tone}>{children}</span>;
}

function modeChip(mode: ProviderStatus['mode']) {
  if (mode === 'live') return <Chip tone="good">live</Chip>;
  if (mode === 'mock') return <Chip tone="warn">mock</Chip>;
  return <Chip tone="neutral">disabled</Chip>;
}

function healthChip(healthy: boolean) {
  return healthy ? <Chip tone="good">healthy</Chip> : <Chip tone="bad">unhealthy</Chip>;
}

function mcpStatusChip(status: McpConnection['status']) {
  if (status === 'connected') return <Chip tone="good">connected</Chip>;
  if (status === 'error') return <Chip tone="bad">error</Chip>;
  return <Chip tone="neutral">disabled</Chip>;
}

function availabilityChip(availability?: ToolCatalogEntry['availability']) {
  if (availability === 'available') return <Chip tone="good">available</Chip>;
  if (availability === 'requires_connection') return <Chip tone="warn">requires connection</Chip>;
  return <Chip tone="bad">unavailable</Chip>;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

/** Shared "couldn't reach the API" block, always with a way to retry. */
function LoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="error-note">
      <p>Couldn&apos;t reach the API: {error}</p>
      <button className="secondary-button" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

export function Connections() {
  const providers = useAsync(() => api.providers());
  const mcp = useAsync(() => api.listMcpConnections());
  const composio = useAsync(() => api.composioTools());
  const tools = useAsync(() => api.tools());

  return (
    <div className="library-page connections-page">
      <header className="library-heading">
        <div>
          <h1>Connections</h1>
          <p>
            What the control plane is actually wired to right now — providers, tool sources, and the
            reviewed catalog Hermes is allowed to see.
          </p>
        </div>
      </header>

      <ProvidersSection state={providers} />
      <BrowserBackendsSection providers={providers} tools={tools} />
      <CredentialsPanel />
      <SupervisionExamples />
      <ToolSourcesSection composio={composio} mcp={mcp} />
      <ToolInventorySection state={tools} />
    </div>
  );
}

/* ------------------------------------------------------------------ Providers */

function ProvidersSection({
  state,
}: {
  state: ReturnType<
    typeof useAsync<{ providers: ProviderStatus[]; bindings: Record<Capability, ProviderId> }>
  >;
}) {
  return (
    <section className="surface-section">
      <header>
        <h2>Providers</h2>
        <button className="icon-button" aria-label="Refresh providers" onClick={state.reload}>
          <Icon name="replay" size={15} />
        </button>
      </header>
      <div>
        {state.loading ? (
          <p className="inline-note">Loading provider status…</p>
        ) : state.error ? (
          <LoadError error={state.error} onRetry={state.reload} />
        ) : !state.data || state.data.providers.length === 0 ? (
          <p className="inline-note">No providers are registered.</p>
        ) : (
          <div className="connections-table">
            <div className="connections-table-head">
              <span>Provider</span>
              <span>Capabilities</span>
              <span>Mode</span>
              <span>Health</span>
            </div>
            {state.data.providers.map((provider) => (
              <div className="connections-table-row" key={provider.id}>
                <span>
                  <strong>{provider.id}</strong>
                  {provider.id === 'browserbase' && (
                    <small>
                      Deprecated · compatibility backend. Switch to Browserless after hosted
                      validation.
                    </small>
                  )}
                </span>
                <span className="connections-caps">{provider.capabilities.join(', ')}</span>
                <span>{modeChip(provider.mode)}</span>
                <span>
                  {healthChip(provider.healthy)}
                  {provider.detail && <small>{provider.detail}</small>}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ Browser backends */

/**
 * The three browser backends, side by side: which one new browser sessions use
 * (`bindings.browser`, from BROWSER_BACKEND), which one serves local-only work
 * (`bindings['browser.local']`), and whether each is live, mocked or off. Facts
 * come from /providers and /tools; the copy only explains them.
 */
const BROWSER_BACKENDS: {
  id: ProviderId;
  name: string;
  where: string;
  about: string;
  enable: string;
}[] = [
  {
    id: 'localbrowser',
    name: 'Local browser (Playwright)',
    where: 'This machine',
    about:
      'Your installed Chrome, driven by Playwright. No browser-service charge; some sites block automated Chrome.',
    enable: 'BROWSER_BACKEND=localbrowser, LOCALBROWSER_MODE=live, LOCALBROWSER_CHANNEL=chrome',
  },
  {
    id: 'browserless',
    name: 'Browserless',
    where: 'Cloud',
    about:
      'Hosted Chrome over CDP with a revocable live viewer. Needs a Browserless API key; the free plan ends sessions after 2 minutes.',
    enable: 'BROWSER_BACKEND=browserless, BROWSERLESS_MODE=live, BROWSERLESS_API_KEY',
  },
  {
    id: 'browserbase',
    name: 'Browserbase',
    where: 'Cloud',
    about: 'Deprecated compatibility backend. Existing browserbase.* tools keep working.',
    enable: 'BROWSER_BACKEND=browserbase, BROWSERBASE_MODE=live, BROWSERBASE_API_KEY',
  },
];

function BrowserBackendsSection({
  providers,
  tools,
}: {
  providers: ReturnType<
    typeof useAsync<{ providers: ProviderStatus[]; bindings: Record<Capability, ProviderId> }>
  >;
  tools: ReturnType<typeof useAsync<{ tools: ToolCatalogEntry[] }>>;
}) {
  const statusOf = (id: ProviderId) => providers.data?.providers.find((p) => p.id === id);
  const preferred = providers.data?.bindings.browser;
  const localRoute = providers.data?.bindings['browser.local'];
  return (
    <section className="surface-section" aria-labelledby="browser-backends-heading">
      <header>
        <h2 id="browser-backends-heading">Browser backends</h2>
        <button
          className="icon-button"
          aria-label="Refresh browser backends"
          onClick={() => {
            providers.reload();
            tools.reload();
          }}
        >
          <Icon name="replay" size={15} />
        </button>
      </header>
      <div>
        {providers.loading ? (
          <p className="inline-note">Loading browser backends…</p>
        ) : providers.error ? (
          <LoadError error={providers.error} onRetry={providers.reload} />
        ) : (
          <>
            <p className="inline-note">
              New browser sessions use{' '}
              <strong>
                {BROWSER_BACKENDS.find((backend) => backend.id === preferred)?.name ?? 'no backend'}
              </strong>
              . Each backend's own tools (browserless.*, localbrowser.*) stay pinned to it. The
              backend is chosen in the API&apos;s .env and takes effect after a restart.
            </p>
            <div className="tool-sources-grid">
              {BROWSER_BACKENDS.map((backend) => {
                const status = statusOf(backend.id);
                const backendTools = (tools.data?.tools ?? []).filter(
                  (tool) => tool.providerId === backend.id,
                );
                const usable = backendTools.filter((tool) => tool.availability === 'available');
                return (
                  <div className="tool-source-card" key={backend.id}>
                    <div className="tool-source-heading">
                      <h3>{backend.name}</h3>
                      {status ? modeChip(status.mode) : <Chip tone="neutral">unknown</Chip>}
                    </div>
                    <p className="tool-source-detail">{backend.about}</p>
                    <ul className="tool-source-list">
                      <li>
                        <span>Runs on</span>
                        <span>{backend.where}</span>
                      </li>
                      <li>
                        <span>New sessions</span>
                        {preferred === backend.id ? (
                          <Chip tone="good">default</Chip>
                        ) : (
                          <Chip tone="neutral">not default</Chip>
                        )}
                      </li>
                      {localRoute === backend.id && (
                        <li>
                          <span>Local-only work</span>
                          <Chip tone="good">used</Chip>
                        </li>
                      )}
                      <li>
                        <span>Health</span>
                        {status ? healthChip(status.healthy) : <Chip tone="neutral">unknown</Chip>}
                      </li>
                      <li>
                        <span>Tools</span>
                        <span>
                          {tools.loading
                            ? '…'
                            : usable.length.toString() +
                              ' of ' +
                              backendTools.length.toString() +
                              ' usable' +
                              (status?.mode === 'mock' && usable.length > 0 ? ' (simulated)' : '')}
                        </span>
                      </li>
                    </ul>
                    {status?.detail && <p className="inline-note">{status.detail}</p>}
                    {status?.mode !== 'live' && (
                      <p className="inline-note">
                        To use it live, set <code>{backend.enable}</code>.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- Tool sources */

function ToolSourcesSection({
  composio,
  mcp,
}: {
  composio: ReturnType<typeof useAsync<{ tools: ComposioTool[] }>>;
  mcp: ReturnType<typeof useAsync<{ connections: McpConnection[] }>>;
}) {
  return (
    <section className="surface-section">
      <header>
        <h2>Tool sources</h2>
      </header>
      <div className="tool-sources-grid">
        <ComposioCard state={composio} />
        <McpCard state={mcp} />
      </div>
    </section>
  );
}

function ComposioCard({
  state,
}: {
  state: ReturnType<typeof useAsync<{ tools: ComposioTool[] }>>;
}) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  const connect = async () => {
    setBusy(true);
    setActionError('');
    try {
      const { url } = await api.composioConnect();
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setActionError(errorMessage(err, 'Could not start Composio OAuth.'));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setBusy(true);
    setActionError('');
    try {
      await api.composioRefresh();
      state.reload();
    } catch (err) {
      setActionError(errorMessage(err, 'Could not refresh Composio.'));
    } finally {
      setBusy(false);
    }
  };

  const connectedCount = state.data?.tools.filter((tool) => tool.connected).length ?? 0;

  return (
    <div className="tool-source-card">
      <div className="tool-source-heading">
        <h3>Composio</h3>
        {state.loading ? (
          <Chip tone="neutral">checking…</Chip>
        ) : state.error ? (
          <Chip tone="bad">unreachable</Chip>
        ) : connectedCount > 0 ? (
          <Chip tone="good">connected</Chip>
        ) : (
          <Chip tone="neutral">not connected</Chip>
        )}
      </div>
      <p className="tool-source-detail">
        Managed-app tools (Gmail for the live demo). The API owns the account and OAuth tokens; this
        page only shows connected/not-connected and tool availability.
      </p>
      {state.error ? (
        <LoadError error={state.error} onRetry={state.reload} />
      ) : state.loading ? (
        <p className="inline-note">Loading Composio tools…</p>
      ) : !state.data || state.data.tools.length === 0 ? (
        <p className="inline-note">No Composio tools are configured yet.</p>
      ) : (
        <ul className="tool-source-list">
          {state.data.tools.map((tool) => (
            <li key={tool.name}>
              <span>{tool.name}</span>
              {tool.connected ? (
                <Chip tone="good">connected</Chip>
              ) : (
                <Chip tone="neutral">not connected</Chip>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="tool-source-actions">
        <button className="primary-button" disabled={busy} onClick={() => void connect()}>
          {busy ? 'Working…' : 'Connect'}
        </button>
        <button className="secondary-button" disabled={busy} onClick={() => void refresh()}>
          <Icon name="replay" size={14} />
          Refresh
        </button>
      </div>
      {actionError && (
        <p className="error-note" role="alert">
          {actionError}
        </p>
      )}
    </div>
  );
}

function McpCard({
  state,
}: {
  state: ReturnType<typeof useAsync<{ connections: McpConnection[] }>>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState('');

  const refreshOne = async (id: string) => {
    setBusyId(id);
    setRowError('');
    try {
      await api.refreshMcpConnection(id);
      state.reload();
    } catch (err) {
      setRowError(errorMessage(err, 'Could not refresh that server.'));
    } finally {
      setBusyId(null);
    }
  };

  const toggle = async (connection: McpConnection) => {
    setBusyId(connection.id);
    setRowError('');
    try {
      await api.setMcpConnectionEnabled(connection.id, !connection.enabled);
      state.reload();
    } catch (err) {
      setRowError(errorMessage(err, 'Could not change that server.'));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (connection: McpConnection) => {
    if (!window.confirm('Remove "' + connection.name + '"? This cannot be undone.')) return;
    setBusyId(connection.id);
    setRowError('');
    try {
      await api.removeMcpConnection(connection.id);
      state.reload();
    } catch (err) {
      setRowError(errorMessage(err, 'Could not remove that server.'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="tool-source-card">
      <div className="tool-source-heading">
        <h3>Generic MCP servers</h3>
        <button className="icon-button" aria-label="Refresh MCP list" onClick={state.reload}>
          <Icon name="replay" size={14} />
        </button>
      </div>
      <p className="tool-source-detail">
        HTTP Streamable MCP servers you've added. Unknown tool names stay unavailable until
        classified — fail-closed by design.
      </p>
      {state.error ? (
        <LoadError error={state.error} onRetry={state.reload} />
      ) : state.loading ? (
        <p className="inline-note">Loading MCP connections…</p>
      ) : !state.data || state.data.connections.length === 0 ? (
        <p className="inline-note">No MCP servers are configured yet.</p>
      ) : (
        <ul className="mcp-list">
          {state.data.connections.map((connection) => (
            <li key={connection.id} className="mcp-row">
              <div className="mcp-row-main">
                <strong>{connection.name}</strong>
                <small>{connection.url}</small>
              </div>
              <div className="mcp-row-facts">
                {mcpStatusChip(connection.status)}
                <span>
                  {connection.executableToolIds.length}/{connection.toolIds.length} tools executable
                </span>
                {connection.lastRefreshedAt && (
                  <span>Refreshed {new Date(connection.lastRefreshedAt).toLocaleString()}</span>
                )}
                {connection.lastError && (
                  <span className="warning-text">{connection.lastError}</span>
                )}
              </div>
              <div className="mcp-row-actions">
                <button
                  className="secondary-button"
                  disabled={busyId === connection.id}
                  onClick={() => void toggle(connection)}
                >
                  {connection.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  className="icon-button"
                  aria-label={'Refresh ' + connection.name}
                  disabled={busyId === connection.id}
                  onClick={() => void refreshOne(connection.id)}
                >
                  <Icon name="replay" size={14} />
                </button>
                <button
                  className="icon-button"
                  aria-label={'Remove ' + connection.name}
                  disabled={busyId === connection.id}
                  onClick={() => void remove(connection)}
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {rowError && (
        <p className="error-note" role="alert">
          {rowError}
        </p>
      )}
      <AddMcpForm onAdded={state.reload} />
    </div>
  );
}

function AddMcpForm({ onAdded }: { onAdded: () => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [headerName, setHeaderName] = useState('');
  const [headerEnvVar, setHeaderEnvVar] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError('');
    if (!name.trim() || !url.trim()) {
      setFormError('Name and URL are required.');
      return;
    }
    if (Boolean(headerName.trim()) !== Boolean(headerEnvVar.trim())) {
      setFormError('Fill in both the header name and the env var name, or neither.');
      return;
    }
    setSubmitting(true);
    try {
      await api.addMcpConnection({
        name: name.trim(),
        url: url.trim(),
        headerEnv:
          headerName.trim() && headerEnvVar.trim()
            ? { [headerName.trim()]: headerEnvVar.trim() }
            : undefined,
      });
      setName('');
      setUrl('');
      setHeaderName('');
      setHeaderEnvVar('');
      onAdded();
    } catch (err) {
      setFormError(errorMessage(err, 'Could not add that server.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="add-connection-form" onSubmit={(event) => void submit(event)}>
      <div className="field">
        <label htmlFor="mcp-name">Name</label>
        <input
          id="mcp-name"
          value={name}
          disabled={submitting}
          onChange={(event) => setName(event.target.value)}
          placeholder="Company tools"
        />
      </div>
      <div className="field">
        <label htmlFor="mcp-url">URL</label>
        <input
          id="mcp-url"
          value={url}
          disabled={submitting}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://mcp.example.com/mcp"
        />
      </div>
      <div className="field">
        <label htmlFor="mcp-header-name">Header name (optional)</label>
        <input
          id="mcp-header-name"
          value={headerName}
          disabled={submitting}
          onChange={(event) => setHeaderName(event.target.value)}
          placeholder="Authorization"
        />
      </div>
      <div className="field">
        <label htmlFor="mcp-header-env">Server env var name (optional)</label>
        <input
          id="mcp-header-env"
          value={headerEnvVar}
          disabled={submitting}
          onChange={(event) => setHeaderEnvVar(event.target.value)}
          placeholder="COMPANY_MCP_AUTH_HEADER"
        />
      </div>
      <p className="inline-note">
        Enter the NAME of a server environment variable, never the secret value itself. Configure
        the actual value outside the browser, in the server's own .env.
      </p>
      {submitting && <p className="notice">Discovering tools — this can take about 20 seconds…</p>}
      {formError && (
        <p className="error-note" role="alert">
          {formError}
        </p>
      )}
      <button className="primary-button full-width" type="submit" disabled={submitting}>
        {submitting ? 'Adding…' : 'Add server'}
      </button>
    </form>
  );
}

/* ------------------------------------------------------------ Tool inventory */

function ToolInventorySection({
  state,
}: {
  state: ReturnType<typeof useAsync<{ tools: ToolCatalogEntry[] }>>;
}) {
  return (
    <section className="surface-section">
      <header>
        <h2>Reviewed tool inventory</h2>
        <button className="icon-button" aria-label="Refresh tool inventory" onClick={state.reload}>
          <Icon name="replay" size={15} />
        </button>
      </header>
      <div>
        <p className="inline-note">
          Only reviewed tools ever become run candidates. Unknown MCP tools stay unavailable until
          classified — fail-closed by design.
        </p>
        {state.loading ? (
          <p className="inline-note">Loading the tool catalog…</p>
        ) : state.error ? (
          <LoadError error={state.error} onRetry={state.reload} />
        ) : !state.data || state.data.tools.length === 0 ? (
          <p className="inline-note">No tools are registered yet.</p>
        ) : (
          groupByPrefix(state.data.tools).map(([prefix, group]) => (
            <div className="tool-inventory-group" key={prefix}>
              <h3>{prefix}</h3>
              <ul>
                {group.map((tool) => (
                  <li key={tool.name}>
                    <span>{tool.name}</span>
                    <span>
                      {tool.executionMode === 'mock' && <Chip tone="warn">simulated</Chip>}{' '}
                      {availabilityChip(tool.availability)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function groupByPrefix(tools: ToolCatalogEntry[]): [string, ToolCatalogEntry[]][] {
  const groups = new Map<string, ToolCatalogEntry[]>();
  for (const tool of tools) {
    const prefix = tool.name.includes('.') ? tool.name.slice(0, tool.name.indexOf('.')) : tool.name;
    const list = groups.get(prefix) ?? [];
    list.push(tool);
    groups.set(prefix, list);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}
