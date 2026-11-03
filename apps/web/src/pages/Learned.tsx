/**
 * What Zephyr learned (docs/cacp-08-learning-loop.md): every learned preference and skill,
 * the evidence behind it, its versions, and one-click revert. Learning never changes what
 * the agent may do; this page only changes how it does things.
 *
 * All data comes from GET /api/learning. Lifecycle rules (what can be accepted, promoted,
 * proposed) come from lib/learning so the page and its tests agree.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import {
  armSummary,
  confidenceLabel,
  entryActions,
  groupFeed,
  percent,
  type FeedItem,
  type LearnedEntry,
} from '../lib/learning';

const failure = (issue: unknown, fallback: string) => (issue instanceof Error ? issue.message : fallback);
const when = (iso: string) => new Date(iso).toLocaleString();

type Kind = '' | 'pref' | 'skill';

export function Learned() {
  const [kind, setKind] = useState<Kind>('');
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      setItems((await api.learningFeed(kind ? { kind } : {})).items);
    } catch (issue) {
      setError(failure(issue, 'Could not load what Zephyr learned.'));
    }
  }, [kind]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run one action with a busy key, then reload the feed. */
  const act = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      const message = await fn();
      if (message) setNotice(message);
      await load();
    } catch (issue) {
      setError(failure(issue, 'That did not work.'));
    } finally {
      setBusy('');
    }
  };

  const runPass = () =>
    act('pass', async () => {
      const r = await api.learningPass();
      if (!r.ok) throw new Error(r.error ?? 'The learning pass failed.');
      return r.signals === 0
        ? 'Nothing new to learn from.'
        : `Read ${r.signals} signal${r.signals === 1 ? '' : 's'}: ${r.outcomes.length} change${r.outcomes.length === 1 ? '' : 's'}.`;
    });

  const exportProfile = () =>
    act('export', async () => {
      const data = await api.learningExport();
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'zephyr-profile.json';
      a.click();
      URL.revokeObjectURL(url);
      return 'Exported the whole profile.';
    });

  const deleteAll = () =>
    act('delete', async () => {
      setConfirmDelete(false);
      const r = await api.learningDeleteAll();
      return `Forgot ${r.signals} signals and ${r.entries} learned entries.`;
    });

  const groups = items ? groupFeed(items) : null;

  return (
    <div className="library-page learned-page">
      <header className="library-heading">
        <div>
          <h1>What Zephyr learned.</h1>
          <p>
            Preferences and skills Zephyr picked up from your edits, picks and feedback. Each one
            shows the evidence behind it. Revert anything with one click; nothing here changes
            what Zephyr is allowed to do.
          </p>
        </div>
        <div className="learned-toolbar">
          <button className="primary-button" disabled={!!busy} onClick={() => void runPass()}>
            {busy === 'pass' ? 'Learning…' : 'Learn now'}
          </button>
          <button className="secondary-button" disabled={!!busy} onClick={() => void exportProfile()}>
            Export
          </button>
          {!confirmDelete ? (
            <button className="secondary-button learned-danger" disabled={!!busy} onClick={() => setConfirmDelete(true)}>
              Forget everything
            </button>
          ) : (
            <span className="learned-confirm" role="alert">
              Forget every signal and learned entry?
              <button className="secondary-button learned-danger" disabled={!!busy} onClick={() => void deleteAll()}>
                Yes, forget
              </button>
              <button className="secondary-button" onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
            </span>
          )}
        </div>
      </header>

      <div className="learned-filters" role="group" aria-label="Show">
        {(
          [
            ['', 'Everything'],
            ['pref', 'Preferences'],
            ['skill', 'Skills'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            className={'learned-chip' + (kind === value ? ' is-on' : '')}
            aria-pressed={kind === value}
            onClick={() => setKind(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {notice && (
        <p className="learned-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="learn-error" role="alert">
          {error}
        </p>
      )}

      {!groups ? (
        !error && <p className="learned-empty">Loading…</p>
      ) : items!.length === 0 ? (
        <p className="learned-empty">
          Nothing learned yet. Edit an agent's diff, pick between variants or rate a finished task,
          then press <em>Learn now</em>.
        </p>
      ) : (
        <>
          <Section title="Waiting on you" hint="Not confident enough to switch on by themselves." items={groups.candidate} busy={busy} act={act} />
          <Section title="In use" items={groups.active} busy={busy} act={act} />
          <Section title="Retired" items={groups.retired} busy={busy} act={act} />
        </>
      )}
    </div>
  );
}

function Section({
  title,
  hint,
  items,
  busy,
  act,
}: {
  title: string;
  hint?: string;
  items: FeedItem[];
  busy: string;
  act: (key: string, fn: () => Promise<string | void>) => Promise<void>;
}) {
  if (items.length === 0) return null;
  return (
    <section className="learned-section">
      <h2>
        {title} <span>{items.length}</span>
      </h2>
      {hint && <p className="learned-hint">{hint}</p>}
      <div className="learned-list">
        {items.map((item) => (
          <EntryCard key={item.entry.id} item={item} busy={busy} act={act} />
        ))}
      </div>
    </section>
  );
}

function EntryCard({
  item,
  busy,
  act,
}: {
  item: FeedItem;
  busy: string;
  act: (key: string, fn: () => Promise<string | void>) => Promise<void>;
}) {
  const e = item.entry;
  const can = entryActions(item);
  const key = (what: string) => what + ':' + e.id;
  const disabled = !!busy;
  const arms = armSummary(item.arms);

  return (
    <article className={'learned-card is-' + e.status}>
      <header>
        <span className="learned-badge">{e.kind === 'skill' ? 'Skill' : 'Preference'}</span>
        <span className="learned-badge is-quiet">{e.scope === 'project' ? 'Project' : 'Personal'}</span>
        {e.private && <span className="learned-badge is-private">Private · stays on this machine</span>}
        <span className="learned-meta" title={`Scored by ${e.source === 'jev' ? 'Jev' : 'the deterministic fallback'}`}>
          {confidenceLabel(e.confidence)} evidence · {percent(e.confidence)} · v{e.version}
          {e.source === 'fallback' && ' · fallback score'}
        </span>
      </header>

      {e.skill ? (
        <>
          <h3>{e.skill.name}</h3>
          <p>{e.skill.description}</p>
          <details>
            <summary>Skill instructions</summary>
            <pre>{e.skill.body}</pre>
          </details>
        </>
      ) : (
        <h3>{e.text}</h3>
      )}

      {e.status === 'candidate' && !e.autoActivate && (
        <p className="learned-hint">Will not switch on by itself: accept it if it is right.</p>
      )}
      {e.retiredReason && <p className="learned-hint">Retired: {e.retiredReason}.</p>}

      {arms.length > 0 && (
        <ul className="learned-arms" aria-label="Measured runs">
          {arms.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}

      <details>
        <summary>
          Evidence <span>{item.evidence.length}</span>
        </summary>
        {item.evidence.length === 0 ? (
          <p className="learned-hint">No evidence recorded.</p>
        ) : (
          <ul className="learned-evidence">
            {item.evidence.map((ev) => (
              <li key={ev.id}>
                <span className="learned-badge is-quiet">{ev.kind.replace(/_/g, ' ')}</span>
                <span>{ev.summary}</span>
                <time dateTime={ev.at}>{when(ev.at)}</time>
                {ev.private && <span className="learned-badge is-private">private</span>}
              </li>
            ))}
          </ul>
        )}
      </details>

      <details>
        <summary>
          Versions <span>{item.versions.length}</span>
        </summary>
        <ol className="learned-versions">
          {[...item.versions].reverse().map((v) => (
            <li key={v.version}>
              <span>v{v.version}</span>
              <span>{v.reason}</span>
              <time dateTime={v.at}>{when(v.at)}</time>
              {can.restorable.includes(v.version) && (
                <button
                  className="secondary-button"
                  disabled={disabled}
                  onClick={() =>
                    void act(key('restore'), async () => {
                      await api.learningRestore(e.id, v.version);
                      return `Restored v${v.version} as a new version.`;
                    })
                  }
                >
                  Restore
                </button>
              )}
            </li>
          ))}
        </ol>
      </details>

      <footer>
        {can.revert && (
          <button
            className="secondary-button learned-danger"
            disabled={disabled}
            onClick={() => void act(key('revert'), () => entryAction(e, 'revert'))}
          >
            Revert
          </button>
        )}
        {can.accept && (
          <button className="primary-button" disabled={disabled} onClick={() => void act(key('accept'), () => entryAction(e, 'accept'))}>
            {e.status === 'retired' ? 'Turn back on' : 'Accept'}
          </button>
        )}
        {can.promote && (
          <button className="secondary-button" disabled={disabled} onClick={() => void act(key('promote'), () => entryAction(e, 'promote'))}>
            Share with project
          </button>
        )}
        {can.propose && (
          <button
            className="secondary-button"
            disabled={disabled}
            title="Writes it to a local branch. Nothing is pushed; you open the PR."
            onClick={() =>
              void act(key('propose'), async () => {
                const p = await api.learningPropose([e.id]);
                if (p.refused.length && !p.files.length) throw new Error(p.refused.map((r) => r.reason).join('; '));
                return `Committed to local branch ${p.branch}. Nothing was pushed.`;
              })
            }
          >
            Propose to repo
          </button>
        )}
      </footer>
    </article>
  );
}

async function entryAction(e: LearnedEntry, action: 'revert' | 'accept' | 'promote'): Promise<string> {
  await api.learningAction(e.id, action);
  const name = e.skill?.name ?? 'That preference';
  if (action === 'revert') return `${name} is off and will stay off unless you turn it back on.`;
  if (action === 'promote') return `${name} now applies to the project.`;
  return `${name} is on.`;
}
