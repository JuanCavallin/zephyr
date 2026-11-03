/**
 * The run page's coding panels (docs/cacp-09-benchmark-cli-demo.md, "UI and demo"):
 *
 *   Tokens per turn  model calls through the gateway, fresh vs cached input, cost when
 *                    every call was priced, and the lever applied ("14k → 602")
 *   Workspace        the live diff, per-turn checkpoints with rewind, every shell
 *                    command with Zephyr's class and decision, and the shaped results
 *
 * Usage, checkpoints, shell rows and levers come from the run stream (runWork), so a
 * reload rebuilds them. Only the diff and the worktree's liveness are fetched, and they
 * are refetched whenever a checkpoint lands or the run changes state.
 */

import { useEffect, useState } from 'react';
import type { Run } from '@htn/shared';
import { api, type RunWorkspaceDiff } from '../../lib/api';
import {
  compactTokens,
  leverLabel,
  rewindGate,
  shellOutcome,
  SHELL_CLASS_LABEL,
  type RunWork,
  type TurnUsage,
} from '../../lib/runWork';

function cents(value: number | undefined): string {
  if (value === undefined) return 'unpriced';
  return value < 100 ? value.toFixed(value < 1 ? 2 : 1) + '¢' : '$' + (value / 100).toFixed(2);
}

function turnLine(t: TurnUsage): string {
  return (
    `${t.calls} call${t.calls === 1 ? '' : 's'} · ${compactTokens(t.freshInput)} fresh in · ` +
    `${compactTokens(t.cachedInput)} cached · ${compactTokens(t.output)} out · ${cents(t.costCents)}`
  );
}

export function TokenPanel({ work }: { work: RunWork }) {
  if (work.totals.calls === 0 && work.levers.length === 0) return null;
  const { totals } = work;
  return (
    <details className="run-details coding-panel" open>
      <summary>
        Tokens per turn{' '}
        <span>
          {compactTokens(totals.freshInput + totals.cachedInput + totals.output)} tokens ·{' '}
          {cents(totals.costCents)}
          {work.cacheHitRate !== undefined && ` · ${Math.round(work.cacheHitRate * 100)}% cache hits`}
        </span>
      </summary>
      <ol className="coding-turns">
        {work.turns.map((t) => (
          <li key={t.turn}>
            <strong>
              Turn {t.turn}
              {!t.ended && <em> · in progress</em>}
            </strong>
            <span>{turnLine(t)}</span>
            {t.levers.map((lever, index) => (
              <span key={index} className="coding-lever" title={`${lever.rawTokens} → ${lever.shapedTokens} tokens`}>
                {lever.what}: {leverLabel(lever)}
              </span>
            ))}
            {t.toolSetChanged && <span className="coding-note">Tool set changed: the prompt cache was rebuilt.</span>}
            {t.blocked.map((reason, index) => (
              <span key={index} className="coding-warn">
                {reason}: the call was refused.
              </span>
            ))}
          </li>
        ))}
      </ol>
    </details>
  );
}

export function WorkspacePanel({ run, work }: { run: Run | null; work: RunWork }) {
  const runId = run?.id;
  const status = run?.status;
  const [live, setLive] = useState(false);
  const [since, setSince] = useState('');
  const [diff, setDiff] = useState<RunWorkspaceDiff | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [refresh, setRefresh] = useState(0);
  const lastCheckpoint = work.checkpoints.at(-1)?.ref ?? '';

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    setError('');
    api
      .runWorkspace(runId)
      .then(async (ws) => {
        if (cancelled) return;
        setLive(ws.live);
        if (!ws.live) {
          setDiff(null);
          return;
        }
        const next = await api.runWorkspaceDiff(runId, since || undefined);
        if (!cancelled) setDiff(next);
      })
      .catch((issue) => {
        if (!cancelled) setError(issue instanceof Error ? issue.message : 'Could not read the worktree.');
      });
    return () => {
      cancelled = true;
    };
  }, [runId, status, lastCheckpoint, since, refresh]);

  const gate = rewindGate(status, live);
  const rewind = async (ref: string, turn: number) => {
    if (!runId || !gate.allowed) return;
    if (!window.confirm(`Restore the worktree to the end of turn ${turn}? Changes made after it are discarded.`))
      return;
    setBusy(ref);
    setError('');
    try {
      await api.rewindWorkspace(runId, ref);
      setSince('');
      setRefresh((n) => n + 1);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'The rewind was refused.');
    } finally {
      setBusy('');
    }
  };

  // git's own summary line: " 3 files changed, 40 insertions(+), 2 deletions(-)".
  const changed = diff ? Number(/(\d+) files? changed/.exec(diff.stat)?.[1] ?? 0) : 0;
  return (
    <details className="run-details coding-panel" open>
      <summary>
        Workspace{' '}
        <span>
          {live ? (diff ? `${changed} file${changed === 1 ? '' : 's'} changed` : 'reading the worktree') : 'worktree closed'} ·{' '}
          {work.checkpoints.length} checkpoint{work.checkpoints.length === 1 ? '' : 's'} · {work.shell.length} shell
        </span>
      </summary>

      {error && (
        <p className="error-note" role="alert">
          {error}
        </p>
      )}

      {live && (
        <section className="coding-section" aria-label="Diff">
          <header>
            <h4>Diff</h4>
            <label>
              against{' '}
              <select value={since} onChange={(e) => setSince(e.target.value)}>
                <option value="">the base branch</option>
                {work.checkpoints.map((c) => (
                  <option key={c.ref} value={c.ref}>
                    end of turn {c.turn}
                  </option>
                ))}
              </select>
            </label>
          </header>
          {diff && diff.stat.trim() ? (
            <>
              <pre className="coding-stat">{diff.stat.trim()}</pre>
              <details>
                <summary>Patch{diff.truncated && <span> · cut at the size limit; the stat above is complete</span>}</summary>
                <pre className="coding-patch">{diff.patch}</pre>
              </details>
            </>
          ) : (
            <p className="coding-empty">{diff ? 'No changes.' : 'Loading…'}</p>
          )}
        </section>
      )}

      {work.checkpoints.length > 0 && (
        <section className="coding-section" aria-label="Checkpoints">
          <header>
            <h4>Checkpoints</h4>
            {!gate.allowed && <small>{gate.reason}</small>}
          </header>
          <ol className="coding-rows">
            {work.checkpoints.map((c) => (
              <li key={c.ref}>
                <span>
                  Turn {c.turn} <time>{c.at.slice(11, 19)}</time>
                </span>
                <code title={c.ref}>{c.ref.split('/').at(-1)}</code>
                <button
                  className="secondary-button"
                  disabled={!gate.allowed || !!busy}
                  title={gate.allowed ? 'Restore the worktree to this checkpoint' : gate.reason}
                  onClick={() => void rewind(c.ref, c.turn)}
                >
                  {busy === c.ref ? 'Rewinding…' : 'Rewind here'}
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}

      {work.shell.length > 0 && (
        <section className="coding-section" aria-label="Shell commands">
          <header>
            <h4>Shell</h4>
          </header>
          <ol className="coding-rows">
            {work.shell.map((row) => (
              <li key={row.actionId} title={row.reasons.join(' · ')}>
                <code className="coding-command">{row.command}</code>
                <span className={'coding-class coding-class-' + (row.shellClass ?? 'none')}>
                  {row.toolId === 'git.publish'
                    ? 'Publish'
                    : row.toolId === 'git.commit'
                      ? 'Commit'
                      : (SHELL_CLASS_LABEL[row.shellClass ?? ''] ?? 'Unclassified')}
                </span>
                <span>{shellOutcome(row)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {work.levers.length > 0 && (
        <section className="coding-section" aria-label="Shaped results">
          <header>
            <h4>Shaped results</h4>
          </header>
          <ol className="coding-rows">
            {work.levers.map((lever, index) => (
              <li key={index}>
                <span>{lever.what}</span>
                <span className="coding-lever">{leverLabel(lever)} tokens</span>
                <span>
                  {lever.rawTokens > 0 ? Math.round((1 - lever.shapedTokens / lever.rawTokens) * 100) : 0}% smaller
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </details>
  );
}
