import { useEffect, useMemo, useRef, useState } from 'react';
import type { RunView } from '@htn/shared';
import {
  buildDebugEntries,
  debugReport,
  KIND_LABEL,
  type DebugEntry,
  type DebugKind,
  type DebugLevel,
} from '../../lib/debugLog';
import { Icon } from '../ui/Icon';

const KINDS = Object.keys(KIND_LABEL) as DebugKind[];
/** Provider egress is the noisiest source; everything else is on by default. */
const DEFAULT_OFF = new Set<DebugKind>(['provider']);

function clock(ms: number, start: number): string {
  const total = Math.max(0, ms - start) / 1000;
  const minutes = Math.floor(total / 60);
  return minutes > 0
    ? minutes + ':' + (total % 60).toFixed(1).padStart(4, '0')
    : total.toFixed(1) + 's';
}

/**
 * A readable, chronological log of everything the run did, placed under the graph:
 * which step failed, which call is a retry, and the input/output of every model call.
 * Built entirely from the live event stream, so it fills in as the run progresses.
 */
export function DebugLog({
  view,
  selectedNodeId,
}: {
  view: RunView;
  /** When set, a "this node only" filter becomes available. */
  selectedNodeId?: string;
}) {
  const [open, setOpen] = useState(true);
  const [kinds, setKinds] = useState<Set<DebugKind>>(
    () => new Set(KINDS.filter((kind) => !DEFAULT_OFF.has(kind))),
  );
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [nodeOnly, setNodeOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const entries = useMemo(() => buildDebugEntries(view), [view]);
  const runStart = entries[0]?.at ?? Date.now();
  const problems = entries.filter((entry) => entry.level === 'error' || entry.level === 'warn');
  const errors = entries.filter((entry) => entry.level === 'error');

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (!kinds.has(entry.kind)) return false;
      if (problemsOnly && entry.level !== 'error' && entry.level !== 'warn') return false;
      if (nodeOnly && selectedNodeId && entry.nodeId !== selectedNodeId) return false;
      if (!needle) return true;
      return (
        entry.title.toLowerCase().includes(needle) ||
        (entry.summary ?? '').toLowerCase().includes(needle) ||
        entry.details.some((item) => item.value.toLowerCase().includes(needle))
      );
    });
  }, [entries, kinds, problemsOnly, nodeOnly, selectedNodeId, query]);

  useEffect(() => {
    if (!follow || !open) return;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, follow, open]);

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const jumpToFirstError = () => {
    const target = errors[0];
    if (!target) return;
    setProblemsOnly(false);
    setQuery('');
    setKinds(new Set(KINDS));
    setFollow(false);
    setExpanded((current) => new Set(current).add(target.id));
    requestAnimationFrame(() =>
      document
        .getElementById('debug-' + target.id)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
    );
  };

  const copyReport = async () => {
    const header =
      'Run ' +
      (view.run?.id ?? '?') +
      ' · status ' +
      (view.run?.status ?? '?') +
      ' · ' +
      errors.length +
      ' error(s), ' +
      (problems.length - errors.length) +
      ' warning(s)\n\n';
    try {
      await navigator.clipboard.writeText(header + debugReport(visible, runStart));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard can be blocked on insecure origins; the log is still on screen.
    }
  };

  return (
    <section className="debug-log" data-open={open} aria-label="Run debug log">
      <header className="debug-log-head">
        <button
          className="debug-log-title"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          title={open ? 'Collapse the debug log' : 'Expand the debug log'}
        >
          <Icon name={open ? 'chevron' : 'chevronRight'} size={14} />
          <strong>Debug log</strong>
          <span className="debug-count">{entries.length} events</span>
        </button>
        {errors.length > 0 && (
          <button className="debug-pill debug-pill-error" onClick={jumpToFirstError}>
            {errors.length} error{errors.length === 1 ? '' : 's'} · jump to first
          </button>
        )}
        {problems.length - errors.length > 0 && (
          <button
            className="debug-pill debug-pill-warn"
            onClick={() => {
              setOpen(true);
              setProblemsOnly(true);
            }}
          >
            {problems.length - errors.length} warning{problems.length - errors.length === 1 ? '' : 's'}
          </button>
        )}
        {errors.length === 0 && problems.length === 0 && entries.length > 0 && (
          <span className="debug-pill debug-pill-ok">no problems</span>
        )}
        <span className="debug-spacer" />
        <button className="debug-action" onClick={() => void copyReport()}>
          {copied ? 'Copied' : 'Copy report'}
        </button>
      </header>

      {open && (
        <>
          <div className="debug-toolbar">
            <input
              className="debug-search"
              type="search"
              placeholder="Search titles, inputs, outputs…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search the debug log"
            />
            <label className="debug-check">
              <input
                type="checkbox"
                checked={problemsOnly}
                onChange={(event) => setProblemsOnly(event.target.checked)}
              />
              Problems only
            </label>
            {selectedNodeId && (
              <label className="debug-check">
                <input
                  type="checkbox"
                  checked={nodeOnly}
                  onChange={(event) => setNodeOnly(event.target.checked)}
                />
                Selected node only
              </label>
            )}
            <label className="debug-check">
              <input
                type="checkbox"
                checked={follow}
                onChange={(event) => setFollow(event.target.checked)}
              />
              Follow
            </label>
            <button
              className="debug-action"
              onClick={() =>
                setExpanded(expanded.size > 0 ? new Set() : new Set(visible.map((e) => e.id)))
              }
            >
              {expanded.size > 0 ? 'Collapse all' : 'Expand all'}
            </button>
          </div>
          <div className="debug-kinds" role="group" aria-label="Event types">
            {KINDS.map((kind) => (
              <button
                key={kind}
                className="debug-kind"
                aria-pressed={kinds.has(kind)}
                onClick={() =>
                  setKinds((current) => {
                    const next = new Set(current);
                    if (!next.delete(kind)) next.add(kind);
                    return next;
                  })
                }
              >
                {KIND_LABEL[kind]}
              </button>
            ))}
          </div>

          <div className="debug-body" ref={scroller} onWheel={() => setFollow(false)}>
            {visible.length === 0 ? (
              <p className="debug-empty">
                {entries.length === 0
                  ? 'Nothing recorded yet. Events appear here as the run progresses.'
                  : 'No events match the current filters.'}
              </p>
            ) : (
              visible.map((entry) => (
                <Row
                  key={entry.id}
                  entry={entry}
                  runStart={runStart}
                  open={expanded.has(entry.id)}
                  onToggle={() => toggle(entry.id)}
                />
              ))
            )}
          </div>
        </>
      )}
    </section>
  );
}

const LEVEL_MARK: Record<DebugLevel, string> = {
  ok: '✓',
  info: '·',
  pending: '…',
  warn: '!',
  error: '✕',
};

function Row({
  entry,
  runStart,
  open,
  onToggle,
}: {
  entry: DebugEntry;
  runStart: number;
  open: boolean;
  onToggle: () => void;
}) {
  const expandable = entry.details.length > 0;
  return (
    <div className="debug-row" id={'debug-' + entry.id} data-level={entry.level}>
      <button
        className="debug-row-main"
        onClick={onToggle}
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
      >
        <span className="debug-time">{clock(entry.at, runStart)}</span>
        <span className="debug-level" aria-label={entry.level}>
          {LEVEL_MARK[entry.level]}
        </span>
        <span className="debug-kind-tag">{KIND_LABEL[entry.kind]}</span>
        <span className="debug-text">
          <span className="debug-row-title">{entry.title}</span>
          {entry.summary && <span className="debug-row-summary">{entry.summary}</span>}
        </span>
      </button>
      {open && expandable && (
        <dl className="debug-details">
          {entry.details.map((item) => (
            <div key={item.label}>
              <dt>{item.label}</dt>
              <dd>
                <pre>{item.value}</pre>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
