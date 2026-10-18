import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { GraphNode } from '@htn/shared';
import { api } from '../../lib/api';

/** Exercises the real broker and approvals in either backend mode, never frontend timers. */
export function SupervisionExamples() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const launch = async (kind: 'document' | 'spreadsheet' | 'browser') => {
    setBusy(true);
    setError('');
    try {
      const nodes: GraphNode[] =
        kind === 'browser'
          ? [
              {
                id: 'handoff',
                type: 'handoff',
                label: 'Supervised browser handoff',
                position: { x: 0, y: 0 },
                config: {
                  url: 'https://example.com',
                  instruction:
                    'Inspect this demonstration page, then choose Done to continue. No login or purchase is needed.',
                  resumeWhen: 'human_confirms',
                  timeoutMs: 600000,
                },
              },
            ]
          : [
              {
                id: 'draft',
                type: 'tool',
                label: 'Create reviewed ' + kind,
                position: { x: 0, y: 0 },
                config: {
                  tool: 'agentos.' + kind + '_update',
                  args: {
                    artifactId: 'supervision-example',
                    expectedVersion: 'new',
                    ...(kind === 'document'
                      ? { content: '# Project brief\n\nDraft ready for review.\n' }
                      : {
                          values: [
                            ['Task', 'Status'],
                            ['Brief', 'Draft'],
                          ],
                        }),
                  },
                },
              },
              {
                id: 'read',
                type: 'tool',
                label: 'Read artifact version',
                position: { x: 290, y: 0 },
                config: {
                  tool: 'agentos.' + kind + '_read',
                  args: { artifactId: 'supervision-example' },
                },
              },
              {
                id: 'update',
                type: 'tool',
                label: 'Review revised ' + kind,
                position: { x: 580, y: 0 },
                config: {
                  tool: 'agentos.' + kind + '_update',
                  args: {
                    artifactId: 'supervision-example',
                    expectedVersion: '{{read.result.version}}',
                    ...(kind === 'document'
                      ? { content: '# Project brief\n\nReviewed and ready to share.\n' }
                      : {
                          values: [
                            ['Task', 'Status'],
                            ['Brief', 'Reviewed'],
                          ],
                        }),
                  },
                },
              },
            ];
      const edges =
        kind === 'browser'
          ? []
          : [
              { id: 'draft-read', source: 'draft', target: 'read' },
              { id: 'read-update', source: 'read', target: 'update' },
            ];
      const { graph } = await api.createGraph({ name: 'Supervision example: ' + kind });
      await api.saveGraph(graph.id, { nodes, edges, version: graph.version });
      const { run } = await api.runGraph(graph.id);
      navigate('/runs/' + run.id);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Could not start the example.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="surface-section supervision-examples">
      <header>
        <h2>Try supervision</h2>
      </header>
      <p className="inline-note">
        Document and spreadsheet examples use local review artifacts and the real approval flow.
        Mock mode is labeled and keeps artifacts in memory. Browser rehearsal uses the selected
        backend and its configured account.
      </p>
      <div>
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => void launch('document')}
        >
          Review a document change
        </button>
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => void launch('spreadsheet')}
        >
          Review cell changes
        </button>
        <button className="secondary-button" disabled={busy} onClick={() => void launch('browser')}>
          Rehearse browser handoff
        </button>
      </div>
      {error && (
        <p className="error-note" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
