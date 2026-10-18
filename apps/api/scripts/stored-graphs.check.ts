/**
 * Saved-graph compatibility check.
 *
 * Graphs are validated when they are authored, then saved and re-run for as
 * long as they are useful. When a convention or the tool catalog changes, a
 * saved graph can go stale without anyone noticing until a run fails halfway.
 * This check is what a person changing a convention runs to see which saved
 * graphs their change breaks. The same rules gate every run at start
 * (runs.service.ts assertGraphRunnable).
 *
 *   1. Proves each preflight rule fires (self-contained, no data needed).
 *   2. Audits every graph in the local SQLite store against the current code.
 *      The tool check uses the live catalog from a running API when one is
 *      reachable (API_URL, default http://localhost:8787); otherwise it is
 *      skipped and said so, rather than guessed.
 *
 * Exits non-zero when any saved graph has a blocking issue.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { AgentGraph } from '@htn/shared';
import { config } from '../src/config.js';
import { formatPreflightIssues, graphPreflightIssues } from '../src/core/graph/preflight.js';

// ---- 1. The rules themselves -------------------------------------------------

const base: AgentGraph = {
  id: 'graph_check',
  name: 'Preflight check',
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  nodes: [
    {
      id: 'open',
      label: 'Open',
      position: { x: 0, y: 0 },
      type: 'tool',
      config: { tool: 'browserbase.open', args: { url: 'https://example.com' } },
    },
    {
      id: 'handoff',
      label: 'Handoff',
      position: { x: 0, y: 100 },
      type: 'handoff',
      config: {
        instruction: 'Sign in.',
        sessionId: '{{open.result.sessionId}}',
        resumeWhen: 'human_confirms',
      },
    },
  ],
  edges: [{ id: 'e1', source: 'open', target: 'handoff' }],
} as unknown as AgentGraph;
const catalog = new Set(['browserbase.open']);
const withHandoff = (config: Record<string, unknown>): AgentGraph =>
  ({
    ...base,
    nodes: [base.nodes[0], { ...base.nodes[1], config: { ...base.nodes[1]!.config, ...config } }],
  }) as AgentGraph;

assert.deepEqual(graphPreflightIssues(base, catalog), [], 'a current graph must pass');

const legacyRef = graphPreflightIssues(withHandoff({ sessionId: '{{open.sessionId}}' }), catalog);
assert.equal(legacyRef[0]?.severity, 'error');
assert.match(legacyRef[0]?.message ?? '', /use \{\{open\.result\.sessionId\}\}/);

const missingNode = graphPreflightIssues(withHandoff({ sessionId: '{{gone.result.id}}' }), catalog);
assert.match(missingNode[0]?.message ?? '', /no node "gone"/);

const notUpstream = graphPreflightIssues(
  { ...base, edges: [] } as AgentGraph,
  catalog,
);
assert.match(notUpstream[0]?.message ?? '', /not upstream/);

const missingTool = graphPreflightIssues(base, new Set());
assert.deepEqual(
  missingTool.map((issue) => [issue.kind, issue.severity]),
  [['tool', 'error']],
  'a tool node whose tool is gone cannot run',
);

const agentList = graphPreflightIssues(
  {
    ...base,
    nodes: [
      ...base.nodes,
      {
        id: 'agent',
        label: 'Agent',
        position: { x: 0, y: 200 },
        type: 'agent_task',
        config: { goal: 'Look around.', availableTools: ['retired.tool'] },
      },
    ],
  } as AgentGraph,
  catalog,
);
assert.deepEqual(
  agentList.map((issue) => [issue.kind, issue.severity]),
  [['tool', 'warning']],
  'an agent tool list entry that is gone is dropped at run time, not fatal',
);

assert.equal(graphPreflightIssues({ nodes: 'nope' }, catalog)[0]?.kind, 'schema');
assert.equal(graphPreflightIssues(base, null).length, 0, 'catalog null skips the tool check');

console.log('PASS: preflight rules flag stale refs, missing nodes and tools, and schema drift.');

// ---- 2. The graphs actually saved on this machine ----------------------------

const dbPath = config.sqlitePath;
if (!existsSync(dbPath)) {
  console.log('SKIP: no SQLite store at ' + dbPath + '; nothing saved to audit.');
  process.exit(0);
}

let liveCatalog: Set<string> | null = null;
const apiUrl = process.env.API_URL ?? 'http://localhost:' + config.port;
try {
  const response = await fetch(apiUrl + '/api/tools', { signal: AbortSignal.timeout(3000) });
  const body = (await response.json()) as { tools: { name: string; availability?: string }[] };
  liveCatalog = new Set(
    body.tools.filter((tool) => tool.availability !== 'unavailable').map((tool) => tool.name),
  );
} catch {
  console.log('NOTE: no API at ' + apiUrl + '; tool availability is NOT checked this run.');
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare('select body from graphs').all() as { body: string }[];
let blocked = 0;
for (const row of rows) {
  const graph = JSON.parse(row.body) as AgentGraph;
  const issues = graphPreflightIssues(graph, liveCatalog);
  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  if (errors.length > 0) blocked += 1;
  const mark = errors.length > 0 ? 'BLOCKED' : warnings.length > 0 ? 'WARN   ' : 'ok     ';
  console.log(mark + ' ' + graph.id + '  ' + JSON.stringify(graph.name ?? ''));
  if (issues.length > 0) console.log('        ' + formatPreflightIssues(issues));
}
db.close();

console.log(
  '\n' + rows.length + ' saved graph(s), ' + blocked + ' blocked' +
    (liveCatalog ? '' : ' (tool check skipped)') + '.',
);
if (blocked > 0) process.exit(1);
