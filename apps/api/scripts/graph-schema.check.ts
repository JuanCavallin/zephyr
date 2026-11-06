/**
 * Structural checks for the graph document validator.
 *
 * Separate from scripts/smoke.mjs because smoke drives a RUNNING API over HTTP,
 * and there is no graph endpoint yet (that is Phase 1). These assertions run
 * against the schema directly, through the api package's existing tsx — no new
 * test dependency.
 *
 *   pnpm --filter @htn/api check:graph
 *
 * The three refinements below are load-bearing: the interpreter assumes unique
 * node ids, resolvable edges, and an acyclic graph. A cycle in particular is a
 * permanent HANG rather than an error, because the executor awaits a promise
 * per node.
 */

import {
  agentGraphSchema,
  EXECUTOR_BY_NODE_TYPE,
  executorOf,
  findGraphCycle,
  GRAPH_NODE_TYPES,
  NODE_TYPE_ICON,
  styleOf,
} from '@htn/shared';

let failures = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (!condition) failures += 1;
  console.log(
    '  [' + (condition ? 'PASS' : 'FAIL') + '] ' + label + (detail ? ' -> ' + detail : ''),
  );
}

const at = new Date().toISOString();

function graph(nodes: unknown[], edges: unknown[]): unknown {
  return { id: 'g1', name: 'test', nodes, edges, version: 1, createdAt: at, updatedAt: at };
}

const toolNode = (id: string) => ({
  id,
  type: 'tool',
  label: 'Call a tool',
  position: { x: 0, y: 0 },
  config: { tool: 'sheets.append', args: {} },
});

const edge = (id: string, source: string, target: string) => ({ id, source, target });

console.log('Graph schema checks\n');

console.log('1. A valid graph parses');
{
  const result = agentGraphSchema.safeParse(
    graph([toolNode('a'), toolNode('b')], [edge('e1', 'a', 'b')]),
  );
  check(
    'two nodes and one edge is valid',
    result.success,
    result.success ? '' : result.error.message,
  );
}

console.log('\n2. The three rungs of delegation are all expressible');
{
  const result = agentGraphSchema.safeParse(graph([toolNode('a')], []));
  check('a lone `tool` node is a complete graph (0 model calls)', result.success);

  const dispatch = agentGraphSchema.safeParse(
    graph(
      [
        {
          id: 'd',
          type: 'dispatch',
          label: 'Pick a tool',
          position: { x: 0, y: 0 },
          config: {
            goal: 'Record the result somewhere',
            candidateTools: ['sheets.append', 'mail.send'],
            args: { 'sheets.append': { row: 'x' } },
          },
        },
      ],
      [],
    ),
  );
  check(
    'a `dispatch` node is valid (1 cheap call, no harness)',
    dispatch.success,
    dispatch.success ? '' : dispatch.error.message,
  );

  const oneCandidate = agentGraphSchema.safeParse(
    graph(
      [
        {
          id: 'd',
          type: 'dispatch',
          label: 'Pick a tool',
          position: { x: 0, y: 0 },
          config: { goal: 'g', candidateTools: ['only.one'] },
        },
      ],
      [],
    ),
  );
  // One candidate is not a choice - that is a `tool` node, and it should be
  // written as one so it costs nothing.
  check('a dispatch with a single candidate is rejected', !oneCandidate.success);
}

console.log('\n3. The executor axis stays in sync with the node types');
{
  const missing = GRAPH_NODE_TYPES.filter((t) => !(t in EXECUTOR_BY_NODE_TYPE));
  check('every node type maps to an executor', missing.length === 0, missing.join(', '));

  const noIcon = GRAPH_NODE_TYPES.filter((t) => !NODE_TYPE_ICON[t]);
  check('every node type has an icon', noIcon.length === 0, noIcon.join(', '));

  // The one mark that must never be wrong: dashed means we cannot see inside.
  const opaque = GRAPH_NODE_TYPES.filter((t) => styleOf(t).opaque);
  // Opaque means an agent harness runs its own loop: Hermes (agent_task) or Claude
  // Code (coding_task). Nothing else may be dashed.
  check(
    'only the agent-harness node types are opaque',
    opaque.join(',') === 'agent_task,coding_task',
    opaque.join(', '),
  );
  check('a Claude Code coding task is priced like the agent harness', styleOf('coding_task').cost === 'high');

  check(
    'dispatch is priced as a decision, not as a free tool',
    executorOf('dispatch') === 'decision',
  );
  check('a plain tool call is free', styleOf('tool').cost === 'none');
  check('the agent harness is the expensive one', styleOf('agent_task').cost === 'high');
}

console.log('\n4. The three refinements the interpreter depends on');
{
  const dup = agentGraphSchema.safeParse(graph([toolNode('a'), toolNode('a')], []));
  check(
    'duplicate node id is rejected',
    !dup.success && JSON.stringify(dup.error.issues).includes('Duplicate node id'),
  );

  const dangling = agentGraphSchema.safeParse(graph([toolNode('a')], [edge('e1', 'a', 'ghost')]));
  check(
    'an edge to a missing node is rejected',
    !dangling.success && JSON.stringify(dangling.error.issues).includes('does not exist'),
  );

  const cyclic = agentGraphSchema.safeParse(
    graph(
      [toolNode('a'), toolNode('b'), toolNode('c')],
      [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'c', 'a')],
    ),
  );
  check(
    'a cycle is rejected rather than hanging the executor',
    !cyclic.success && JSON.stringify(cyclic.error.issues).includes('cycle'),
  );

  const selfLoop = agentGraphSchema.safeParse(graph([toolNode('a')], [edge('e1', 'a', 'a')]));
  check('a self-loop counts as a cycle', !selfLoop.success);
}

console.log('\n5. findGraphCycle is usable on its own');
{
  const cycle = findGraphCycle(
    [{ id: 'a' }, { id: 'b' }],
    [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
    ],
  );
  check('reports the offending node ids', cycle !== null && cycle.length >= 2, String(cycle));

  const diamond = findGraphCycle(
    [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'c' },
      { source: 'b', target: 'd' },
      { source: 'c', target: 'd' },
    ],
  );
  // A diamond revisits `d` on a second path without being cyclic; a visitor
  // that forgets to mark nodes done would report a false cycle here.
  check('a diamond (shared descendant) is NOT a cycle', diamond === null, String(diamond));
}

console.log('\n6. Config is validated per node type');
{
  const badTool = agentGraphSchema.safeParse(
    graph([{ ...toolNode('a'), config: { args: {} } }], []),
  );
  check('a tool node without a tool name is rejected', !badTool.success);

  const badJudge = agentGraphSchema.safeParse(
    graph(
      [
        {
          id: 'j',
          type: 'judge',
          label: 'Judge',
          position: { x: 0, y: 0 },
          config: { question: 'Which?', options: ['only-one'] },
        },
      ],
      [],
    ),
  );
  check('a judge with fewer than two options is rejected', !badJudge.success);
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
