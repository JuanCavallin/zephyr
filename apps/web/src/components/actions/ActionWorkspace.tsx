import { useEffect, useRef, useState } from 'react';
import type { ActionEvidence, ActionPreview, Approval, Step } from '@htn/shared';
import { api } from '../../lib/api';
import {
  actionStatus,
  actionFailureConsequence,
  approvalPreviewReady,
  redactCredentialFields,
  type WorkspaceAction,
} from '../../lib/actions';
import { ApprovalPanel } from '../approvals/ApprovalPanel';
import { BrowserPanel, type PanelSession } from '../graph/BrowserPanel';
import { providerLabel } from '../../lib/workspace';
import { Icon } from '../ui/Icon';

function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/** Pure renderers consume server-bounded data; provider HTML is always plain text. */
export function ChangePreview({
  preview,
  executed = false,
  simulated = false,
}: {
  preview: ActionPreview;
  executed?: boolean;
  simulated?: boolean;
}) {
  if (preview.message)
    return (
      <section
        className="message-preview"
        aria-label={
          simulated ? 'Simulated message' : executed ? 'Completed message' : 'Proposed message'
        }
      >
        <dl>
          <dt>To</dt>
          <dd>{preview.message.to ?? 'Recipient unavailable'}</dd>
          <dt>Subject</dt>
          <dd>{preview.message.subject ?? 'No subject'}</dd>
        </dl>
        <pre>
          {preview.message.body ?? 'Content preview unavailable. Review the exact payload.'}
        </pre>
      </section>
    );
  if (!preview.changes?.length)
    return (
      <p className="inline-note">
        Outcome preview unavailable. Review the exact instructions in Details; no before/after
        change has been inferred.
      </p>
    );
  if (preview.kind === 'spreadsheet')
    return (
      <div className="action-table-scroll">
        <table className="action-change-table">
          <caption>
            {simulated
              ? 'Simulated cell changes'
              : executed
                ? 'Verified cell changes'
                : 'Proposed cell changes'}
          </caption>
          <thead>
            <tr>
              <th scope="col">Location</th>
              <th scope="col">Before</th>
              <th scope="col">
                {simulated ? 'Simulated after' : executed ? 'Actual after' : 'Proposed after'}
              </th>
            </tr>
          </thead>
          <tbody>
            {preview.changes.map((change, index) => (
              <tr key={index}>
                <th scope="row">{change.location}</th>
                <td>
                  {change.before === undefined ? (
                    'Before state unavailable'
                  ) : (
                    <pre>{formatValue(change.before)}</pre>
                  )}
                </td>
                <td>
                  <pre>{formatValue(change.after)}</pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  return (
    <div className="action-changes">
      {preview.changes.map((change, index) => (
        <section className="action-change" key={index}>
          <h3>{change.location}</h3>
          <div>
            <section aria-label="Before">
              <small>− Before</small>
              <pre>
                {change.before === undefined
                  ? 'Before state unavailable'
                  : formatValue(change.before)}
              </pre>
            </section>
            <section
              aria-label={
                simulated ? 'Simulated after' : executed ? 'Actual after' : 'Proposed after'
              }
            >
              <small>
                + {simulated ? 'Simulated after' : executed ? 'Actual after' : 'Proposed after'}
              </small>
              <pre>{formatValue(change.after)}</pre>
            </section>
          </div>
        </section>
      ))}
    </div>
  );
}

export function ActionWorkspace({
  action,
  session,
  steps = [],
  handoff,
  onClose,
  onResume,
  connected = true,
  busy = false,
}: {
  action?: WorkspaceAction;
  session?: PanelSession;
  steps?: Step[];
  handoff?: Approval;
  onClose: () => void;
  onResume?: (approvalId: string) => void | Promise<void>;
  connected?: boolean;
  busy?: boolean;
}) {
  const [tab, setTab] = useState<'changes' | 'details' | 'history'>('changes');
  const [expanded, setExpanded] = useState(false);
  const [evidence, setEvidence] = useState<ActionEvidence[]>([]);
  const [previews, setPreviews] = useState<{ evidence: ActionEvidence; preview: ActionPreview }[]>(
    [],
  );
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(Boolean(action));
  const [previewRefresh, setPreviewRefresh] = useState(0);
  const root = useRef<HTMLElement>(null);
  const selectedId = action?.id ?? session?.sessionId;
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    root.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    setTab('changes');
  }, [selectedId]);
  useEffect(() => {
    setEvidence([]);
    setPreviews([]);
    setError('');
    if (!action) return;
    let active = true;
    setLoading(true);
    api
      .actionEvidence(action.latest.runId, action.id)
      .then(async (result) => {
        if (!active) return;
        setEvidence(result.evidence);
        const rendered = await Promise.all(
          result.evidence
            .filter((item) => item.previewRef)
            .map(async (item) => ({
              evidence: item,
              preview: (await api.actionPreview(action.latest.runId, item.previewRef!)).preview,
            })),
        );
        if (active) setPreviews(rendered);
      })
      .catch((issue) => {
        if (active) setError(issue instanceof Error ? issue.message : 'Preview unavailable.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [action?.id, action?.latest.phase, action?.events.length, previewRefresh]);
  const pending = action?.approval?.status === 'pending' ? action.approval : undefined;
  const args = action?.latest.action.arguments;
  const requiresPreview = Boolean(
    args && typeof args === 'object' && !Array.isArray(args) && typeof args.previewRef === 'string',
  );
  const previewReady = !action || approvalPreviewReady(action, previews);
  const status = session
    ? session.closedAt
      ? 'Session ended'
      : 'Browser session'
    : action
      ? actionStatus(action, evidence)
      : 'Action';
  const executionMode =
    [...evidence].reverse().find((item) => item.executionMode)?.executionMode ??
    action?.latest.evidence?.executionMode;
  return (
    <aside
      ref={root}
      tabIndex={-1}
      className={'action-workspace' + (expanded ? ' is-expanded' : '')}
      aria-label="Action workspace"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && event.target === root.current) onClose();
      }}
    >
      <header className="action-workspace-header">
        <Icon name={session ? 'globe' : 'file'} size={17} />
        <div>
          <span className="action-eyebrow">Action workspace</span>
          <h2>
            {session
              ? providerLabel(session.providerId) + ' browser'
              : (action?.latest.action.toolId ?? 'Action')}
          </h2>
        </div>
        {executionMode && (
          <span
            className={'status-chip status-chip--' + (executionMode === 'mock' ? 'warn' : 'good')}
          >
            {executionMode}
          </span>
        )}
        <button
          className="icon-button"
          onClick={() => setExpanded(!expanded)}
          aria-label={expanded ? 'Dock action workspace' : 'Expand action workspace'}
          aria-pressed={expanded}
        >
          <Icon name="expand" size={16} />
        </button>
        <button className="icon-button" onClick={onClose} aria-label="Close action workspace">
          <Icon name="close" size={16} />
        </button>
      </header>
      {!connected && (
        <p className="action-connection-notice" role="status">
          Reconnecting. Decisions are disabled until the current run state is received.
        </p>
      )}
      {session ? (
        <BrowserPanel
          session={session}
          steps={steps}
          {...(handoff ? { handoff } : {})}
          {...(onResume ? { onResume } : {})}
          onClose={onClose}
          embedded
          busy={busy || !connected}
        />
      ) : (
        action && (
          <>
            <div className="action-status-line">
              <span
                className={
                  'status-chip status-chip--' +
                  (pending
                    ? 'warn'
                    : action.latest.phase === 'failed' || action.latest.phase === 'blocked'
                      ? 'bad'
                      : 'neutral')
                }
              >
                {status}
              </span>
              <span>{action.latest.action.destination ?? 'No external destination'}</span>
              {action.latest.action.accountRef && (
                <span>
                  Connected account (ID): <code>{action.latest.action.accountRef}</code>
                </span>
              )}
            </div>
            <div className="action-tabs" aria-label="Action views">
              {(['changes', 'details', 'history'] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-pressed={tab === item}
                  onClick={() => setTab(item)}
                >
                  {item === 'changes'
                    ? pending
                      ? 'Proposed changes'
                      : 'Result'
                    : item === 'details'
                      ? 'Details'
                      : 'History'}
                </button>
              ))}
            </div>
            <div className="action-workspace-body">
              {tab === 'changes' && (
                <>
                  {loading && (
                    <p className="inline-note" role="status">
                      Loading authorized preview…
                    </p>
                  )}
                  {error && (
                    <div className="inline-note">
                      <p>
                        Preview unavailable: {error}.{' '}
                        {requiresPreview
                          ? 'Approve and revise are disabled until the reviewed content loads. You can still reject this action.'
                          : 'The exact payload remains available in Details.'}
                      </p>
                      <button
                        className="secondary-button"
                        disabled={loading}
                        onClick={() => setPreviewRefresh((value) => value + 1)}
                      >
                        Refresh preview
                      </button>
                    </div>
                  )}
                  {!loading && !previews.length && (
                    <p className="inline-note">
                      This tool has no visual change preview. Its real lifecycle, exact payload, and
                      execution receipt are available here.
                    </p>
                  )}
                  {previews.map((item, index) => (
                    <section
                      className="action-evidence"
                      key={item.evidence.fingerprint + item.evidence.phase}
                    >
                      <header>
                        <h3>{item.preview.title}</h3>
                        <span className="status-chip status-chip--neutral">
                          {item.evidence.phase === 'proposed'
                            ? index > 0
                              ? 'Revised proposal'
                              : 'Original proposal'
                            : item.evidence.executionMode === 'mock'
                              ? 'Simulated result'
                              : item.evidence.evidenceLevel === 'readback_verified'
                                ? 'Readback verified'
                                : 'Provider receipt'}
                        </span>
                      </header>
                      <p>{item.evidence.summary}</p>
                      {item.evidence.phase === 'proposed' ||
                      item.evidence.evidenceLevel === 'readback_verified' ||
                      item.evidence.executionMode === 'mock' ? (
                        <ChangePreview
                          preview={item.preview}
                          executed={item.evidence.phase === 'executed'}
                          simulated={
                            item.evidence.phase === 'executed' &&
                            item.evidence.executionMode === 'mock'
                          }
                        />
                      ) : (
                        <p className="inline-note">
                          The provider reported completion. Independent readback has not been
                          verified.
                        </p>
                      )}
                      {item.preview.truncated && (
                        <p className="action-truncation">
                          Preview is bounded; additional changes or content are omitted.
                        </p>
                      )}
                      {item.evidence.baseVersion && (
                        <small>Base version: {item.evidence.baseVersion}</small>
                      )}
                      {item.evidence.resultingVersion && (
                        <small>Resulting version: {item.evidence.resultingVersion}</small>
                      )}
                    </section>
                  ))}
                  {action.latest.outputSummary && (
                    <section className="action-result">
                      <h3>Execution receipt</h3>
                      <p>{action.latest.outputSummary}</p>
                    </section>
                  )}
                  {action.latest.error && (
                    <p className="error-note" role="alert">
                      {action.latest.error.message} {actionFailureConsequence(action)}
                    </p>
                  )}
                </>
              )}
              {tab === 'details' && (
                <>
                  <dl className="action-facts">
                    <dt>Action</dt>
                    <dd>{action.id}</dd>
                    <dt>Destination</dt>
                    <dd>{action.latest.action.destination ?? 'None'}</dd>
                    {action.latest.action.accountRef && (
                      <>
                        <dt>Connected account (ID)</dt>
                        <dd>{action.latest.action.accountRef}</dd>
                      </>
                    )}
                    <dt>Data labels</dt>
                    <dd>{action.latest.action.dataLabels.join(', ')}</dd>
                    <dt>Policy</dt>
                    <dd>
                      {[...action.events].reverse().find((event) => event.authorization)
                        ?.authorization?.finalPolicy ?? 'Pending'}
                    </dd>
                  </dl>
                  <h3>Exact proposed arguments</h3>
                  <pre className="action-payload">
                    {JSON.stringify(
                      redactCredentialFields(
                        previews.find((item) => item.evidence.phase === 'proposed')?.preview
                          .arguments ?? action.events[0]!.action.arguments,
                      ),
                      null,
                      2,
                    )}
                  </pre>
                  {action.approval?.revisedAction && (
                    <>
                      <h3>Reauthorized revision</h3>
                      <pre className="action-payload">
                        {JSON.stringify(
                          redactCredentialFields(action.approval.revisedAction),
                          null,
                          2,
                        )}
                      </pre>
                    </>
                  )}
                </>
              )}
              {tab === 'history' && (
                <ol className="action-history">
                  {action.events.map((event) => (
                    <li key={event.id}>
                      <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString()}</time>
                      <strong>{event.phase.replaceAll('_', ' ')}</strong>
                      {event.outputSummary && <p>{event.outputSummary}</p>}
                      {event.error && <p>{event.error.message}</p>}
                    </li>
                  ))}
                </ol>
              )}
            </div>
            {pending && (
              <footer className="action-decision-footer">
                <p>
                  Approval authorizes this exact action. Rejecting prevents it; earlier completed
                  actions remain.
                </p>
                {!loading && !previewReady && (
                  <p className="action-truncation">
                    The complete reviewed payload is unavailable or changed. Approve and revise stay
                    disabled; reject this action or request smaller changes.
                  </p>
                )}
                <ApprovalPanel
                  key={pending.id}
                  approval={pending}
                  decisionsDisabled={busy || !connected}
                  approvalDisabled={loading || !previewReady}
                  compact
                />
              </footer>
            )}
          </>
        )
      )}
    </aside>
  );
}
