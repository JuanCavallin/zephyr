import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { ProviderStatus } from '@htn/shared';
import { api } from '../../lib/api';
import { Icon, Mark } from '../ui/Icon';
import { Nav } from './Nav';
import { applyTheme, readStoredTheme, type ThemeId } from '../../lib/theme';

const HarnessContext = createContext<{ providers: ProviderStatus[]; openConnection: () => void }>({
  providers: [],
  openConnection: () => undefined,
});
export const useHarness = () => useContext(HarnessContext);

export function AppShell({ children }: { children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [checking, setChecking] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const connection = useRef<HTMLDialogElement>(null);
  const location = useLocation();
  // Read once from storage, then own it here. A blocked store just means the default.
  const [theme, setTheme] = useState<ThemeId>(() => readStoredTheme());
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  const hermes = providers.find((provider) => provider.id === 'hermes');
  const connected = hermes?.healthy && hermes.mode === 'live';

  useEffect(() => {
    setNavOpen(false);
  }, [location]);
  useEffect(() => {
    if (connectionOpen) connection.current?.showModal();
    else connection.current?.close();
  }, [connectionOpen]);

  const connect = async () => {
    setChecking(true);
    setConnectionError('');
    try {
      const result = await api.providers();
      setProviders(result.providers);
      const runtime = result.providers.find((provider) => provider.id === 'hermes');
      if (!runtime)
        setConnectionError(
          'The API did not report a Hermes adapter. Check the backend configuration.',
        );
      else if (!runtime.healthy)
        setConnectionError(
          runtime.detail ||
            'Hermes did not pass its health check. Check the local runtime and try again.',
        );
    } catch (error) {
      setProviders([]);
      setConnectionError(
        'Could not reach the Zephyr API. Start the backend on port 8787, then try again. ' +
          (error instanceof Error ? error.message : ''),
      );
    } finally {
      setChecking(false);
    }
  };

  // Load provider health once on mount. Without this the composer's backend mode sees an
  // empty provider list and refuses the first send until the user opens this dialog by hand.
  useEffect(() => {
    void connect();
  }, []);

  return (
    <HarnessContext.Provider value={{ providers, openConnection: () => setConnectionOpen(true) }}>
      <div className="app-shell">
        <a className="skip-link" href="#main-content">
          Skip to workspace
        </a>
        <Nav
          open={navOpen}
          onClose={() => setNavOpen(false)}
          onConnect={() => setConnectionOpen(true)}
          theme={theme}
          onThemeChange={setTheme}
        />
        {navOpen && (
          <button
            className="nav-backdrop"
            aria-label="Close navigation"
            onClick={() => setNavOpen(false)}
          />
        )}
        <div className="app-main">
          <header className="workspace-header">
            <div className="workspace-breadcrumb">
              <button
                className="icon-button mobile-menu"
                aria-label="Toggle navigation"
                aria-expanded={navOpen}
                onClick={() => setNavOpen(!navOpen)}
              >
                <Icon name="menu" />
              </button>
              <Link to="/" className="header-brand" aria-label="Zephyr home">
                <Mark small />
                <span>Zephyr</span>
              </Link>
              <span className="breadcrumb-divider">/</span>
              <strong>
                {location.pathname.startsWith('/graphs')
                  ? 'Workflows'
                  : location.pathname === '/runs'
                    ? 'Run history'
                    : location.pathname.startsWith('/runs/')
                      ? 'Execution'
                      : location.pathname === '/connections'
                        ? 'Connections'
                        : location.pathname === '/compare'
                          ? 'Compare'
                          : location.pathname === '/benchmarks'
                            ? 'Benchmarks'
                            : 'Conversation'}
              </strong>
            </div>
            <button
              className={`harness-button ${connected ? 'connected' : ''}`}
              onClick={() => setConnectionOpen(true)}
            >
              <Icon name="connect" size={16} />
              <span>
                {checking
                  ? 'Connecting…'
                  : connected
                    ? 'Hermes'
                    : hermes?.mode === 'mock'
                      ? 'Hermes · Mock'
                      : 'Connect harness'}
              </span>
              {connected ? <span className="status-dot" /> : <Icon name="plus" size={14} />}
            </button>
          </header>
          <main id="main-content" tabIndex={-1} className="workspace-main">
            {children}
          </main>
        </div>
        <dialog
          className="connection-dialog"
          ref={connection}
          onClose={() => setConnectionOpen(false)}
          onClick={(event) => {
            if (event.target === event.currentTarget) setConnectionOpen(false);
          }}
        >
          <div className="dialog-heading">
            <Mark small />
            <button
              className="icon-button"
              aria-label="Close harness connection"
              onClick={() => setConnectionOpen(false)}
            >
              <Icon name="close" />
            </button>
          </div>
          <h2>Bring your agent.</h2>
          <p>
            Zephyr makes its execution visible.
            <br />
            Connect your configured local harness to get started.
          </p>
          <div className="harness-choice">
            <span className="harness-emblem">
              <Icon name="connect" size={24} />
            </span>
            <div>
              <strong>Hermes</strong>
              <span>Nous Research · Local ACP</span>
            </div>
            <span className="subtle-tag">
              {connected ? 'Connected' : hermes?.mode === 'mock' ? 'Mock mode' : 'Supported'}
            </span>
          </div>
          <div className="connection-facts">
            <span>
              <Icon name="lock" size={15} /> Credentials stay on the backend
            </span>
            <span>
              <Icon name="activity" size={15} /> Checks the configured ACP connection
            </span>
          </div>
          {hermes?.mode === 'mock' && (
            <p className="notice">
              The backend is using mock Hermes. It is available for testing, but no live harness is
              connected.
            </p>
          )}
          {connected && (
            <p className="success-note" role="status">
              Hermes passed its live connection check. Backend runs are available from the composer.
            </p>
          )}
          {connectionError && (
            <p className="error-note" role="alert">
              {connectionError}
            </p>
          )}
          <button
            className="primary-button full-width"
            onClick={() => void connect()}
            disabled={checking}
          >
            <Icon name={checking ? 'activity' : 'connect'} size={17} />
            {checking
              ? 'Checking local harness…'
              : connected
                ? 'Recheck connection'
                : 'Connect Hermes'}
          </button>
          <p className="dialog-footnote">
            Uses the existing provider health endpoint. Configure Hermes on the API host; this panel
            does not install agents or change credentials.
          </p>
        </dialog>
      </div>
    </HarnessContext.Provider>
  );
}
