import { useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { Icon, Mark } from '../ui/Icon';
import { THEMES, type ThemeId } from '../../lib/theme';

export function Nav({
  open = false,
  onClose,
  onConnect,
  theme,
  onThemeChange,
}: {
  open?: boolean;
  onClose?: () => void;
  onConnect?: () => void;
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
}) {
  const location = useLocation();
  const [help, setHelp] = useState(false);
  const [themes, setThemes] = useState(false);
  return (
    <aside className={`sidebar ${open ? 'is-open' : ''}`} aria-label="Workspace navigation">
      <Link className="brand" to="/">
        <Mark />
        <span>Zephyr</span>
        <span className="brand-beta">beta</span>
      </Link>
      <button
        className="icon-button mobile-nav-close"
        aria-label="Close navigation"
        onClick={onClose}
      >
        <Icon name="close" />
      </button>
      <Link to={'/?new=' + Date.now()} className="new-conversation">
        <Icon name="plus" size={17} />
        <span>New conversation</span>
      </Link>
      <nav className="primary-navigation">
        <NavLink to="/" end>
          <Icon name="chat" />
          <span>Conversations</span>
          <span className="nav-current-dot" />
        </NavLink>
        <NavLink to="/graphs">
          <Icon name="graph" />
          <span>Workflows</span>
        </NavLink>
        <NavLink to="/runs">
          <Icon name="clock" />
          <span>Run history</span>
        </NavLink>
        <NavLink to="/benchmarks">
          <Icon name="activity" />
          <span>Benchmarks</span>
        </NavLink>
        <NavLink to="/connections">
          <Icon name="connect" />
          <span>Connections</span>
        </NavLink>
      </nav>
      <div className="sidebar-section">
        <span className="sidebar-label">Explore an example</span>
        <Link
          className={'example-link ' + (location.search.includes('support') ? 'selected' : '')}
          to="/?example=support"
        >
          <span className="example-mark">
            <Icon name="file" size={14} />
          </span>
          <span>High-risk account research</span>
        </Link>
        <Link
          className={'example-link ' + (location.search.includes('trip') ? 'selected' : '')}
          to="/?example=trip"
        >
          <span className="example-mark">
            <Icon name="globe" size={14} />
          </span>
          <span>A weekend in Toronto</span>
        </Link>
        <p className="sidebar-caption">
          Interactive previews.
          <br />
          No tools or models are called.
        </p>
      </div>
      <div className="sidebar-bottom">
        <button className="sidebar-utility" onClick={onConnect}>
          <Icon name="connect" size={17} />
          Harness connection
        </button>
        <button
          className="sidebar-utility"
          aria-expanded={themes}
          onClick={() => setThemes(!themes)}
        >
          <Icon name="palette" size={17} />
          Theme
          <span className="utility-value">{THEMES.find((item) => item.id === theme)?.label}</span>
        </button>
        {themes && (
          <div className="theme-picker" role="radiogroup" aria-label="Colour theme">
            {THEMES.map((item) => (
              <button
                key={item.id}
                role="radio"
                aria-checked={theme === item.id}
                className={`theme-option ${theme === item.id ? 'chosen' : ''}`}
                onClick={() => onThemeChange(item.id)}
              >
                <span className="theme-swatch" aria-hidden="true">
                  {item.swatch.map((colour) => (
                    <i key={colour} style={{ background: colour }} />
                  ))}
                </span>
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.note}</small>
                </span>
              </button>
            ))}
          </div>
        )}
        <button className="sidebar-utility" aria-expanded={help} onClick={() => setHelp(!help)}>
          <Icon name="help" size={17} />
          How it works
        </button>
        {help && (
          <p className="sidebar-help">
            Describe a task. Zephyr routes the work, records decisions, and stops for required
            approvals. Preview mode lets you explore without calling real tools.
          </p>
        )}
        <div className="workspace-identity">
          <span className="identity-icon">Z</span>
          <div>
            <strong>Local workspace</strong>
            <span>Hack the North 2026</span>
          </div>
          <Icon name="lock" size={13} />
        </div>
      </div>
    </aside>
  );
}
