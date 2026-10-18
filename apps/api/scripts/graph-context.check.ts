/** Interpreter regressions with deterministic local doubles; no server, browser, or provider calls. */
import assert from 'node:assert/strict';
import {
  agentGraphSchema,
  type AgentGraph,
  type GraphNode,
  type Json,
  type ScheduleDecision,
  type Step,
} from '@htn/shared';
import { runGraph } from '../src/core/graph/interpreter.js';
import { lookup, resolveRefs } from '../src/core/graph/refs.js';
import type {
  AgentTaskResult,
  AgentTaskSpec,
  PlaybookContext,
} from '../src/core/playbooks/types.js';

const at = '2026-09-22T00:00:00Z';
const position = { x: 0, y: 0 };
const edge = (source: string, target: string) => ({ id: source + '_' + target, source, target });
const fetchNode = (id: string, text: string): GraphNode => ({
  id,
  type: 'fetch',
  label: id,
  position,
  config: { source: 'local://test', text },
});
const agent = (config: Record<string, unknown> = {}): unknown => ({
  id: 'agent',
  type: 'agent_task',
  label: 'agent',
  position,
  config: { goal: 'Analyze supplied evidence.', availableTools: [], ...config },
});
const tool = (id: string, args: Record<string, Json> = {}): GraphNode => ({
  id,
  type: 'tool',
  label: id,
  position,
  config: { tool: id, args },
});
const handoff = (config: Record<string, unknown> = {}): unknown => ({
  id: 'handoff',
  type: 'handoff',
  label: 'handoff',
  position,
  config: { instruction: 'Review this page.', ...config },
});
const draft = (nodes: unknown[], edges: unknown[] = []) => ({
  id: 'graph_test',
  name: 'Context check',
  version: 1,
  createdAt: at,
  updatedAt: at,
  nodes,
  edges,
});
const graph = (nodes: unknown[], edges: unknown[] = []): AgentGraph =>
  agentGraphSchema.parse(draft(nodes, edges));

function schedule(tools: string[] = []): ScheduleDecision {
  return {
    id: 'decision',
    runId: 'run_test',
    stepId: 'step_test',
    requestedCapability: 'agent.runtime',
    selectedProvider: 'hermes',
    privacy: 'cloud',
    intelligence: 'low',
    privacyConfidence: 1,
    intelligenceConfidence: 1,
    modelTier: 'cheap',
    availableTools: tools,
    exposedTools: tools,
    confidence: 1,
    escalated: false,
    rule: 'test',
    at,
  };
}

function fixture() {
  const tasks: AgentTaskSpec[] = [];
  const calls: { toolId: string; args: Record<string, Json> }[] = [];
  const approvals: unknown[] = [];
  const outputs: unknown[] = [];
  const failures: string[] = [];
  const logs: string[] = [];
  const closed: string[] = [];
  const announcements: unknown[] = [];
  const results = new Map<string, Json>();
  let opened = 0;
  let completions = 0;
  let selectedTool = 'extract';
  let generatedArgs: Record<string, Json> | undefined;
  let stepNumber = 0;
  const meta = {
    provider: 'browserbase' as const,
    mode: 'mock' as const,
    op: 'test',
    latencyMs: 0,
    destination: null,
  };
  const context: PlaybookContext = {
    runId: 'run_test',
    signal: new AbortController().signal,
    async log(_level, message) {
      logs.push(message);
    },
    async step(spec, work) {
      const step: Step = {
        ...spec,
        id: 'step_' + ++stepNumber,
        runId: 'run_test',
        parentStepId: null,
        seq: stepNumber,
        kind: spec.kind ?? 'task',
        status: 'running',
        startedAt: at,
      };
      try {
        const output = await work(step);
        outputs.push(output);
        return output;
      } catch (error) {
        failures.push(spec.nodeId ?? spec.label);
        throw error;
      }
    },
    async runAgentTask(spec) {
      tasks.push(structuredClone(spec));
      return {
        result: { answer: 'test' },
        scheduleDecision: schedule(),
        toolCalls: [],
      } as unknown as AgentTaskResult;
    },
    async callBrokeredTool({ toolId, args }) {
      calls.push({ toolId, args });
      if(toolId==='browserbase.open') {opened+=1;return {output:{sessionId:'new_session'},summary:'Test browser opened.'};}
      return {
        output: results.get(toolId) ?? { text: 'page result' },
        summary: 'Test tool completed.',
      };
    },
    async requireApproval(_stepId, action) {
      approvals.push(action);
      return action;
    },
    async announceBrowserSession(session) {
      announcements.push(session);
    },
    async releaseBrowserSession() {},
    async recordSchedule() {
      return schedule([selectedTool]);
    },
    providerFor(capability) {
      return capability === 'agent.runtime'
        ? 'hermes'
        : capability === 'decision'
          ? 'jev'
          : 'browserbase';
    },
    provider: ((capability: string) => {
      if (capability === 'browser')
        return {
          id:'browserbase',
          async openSession() {
            opened += 1;
            return { ok: true, data: { sessionId: 'new_session' }, meta };
          },
          async closeSession(sessionId: string) {
            closed.push(sessionId);
            return { ok: true, data: null, meta };
          },
          async setOwnership() {},
        };
      if (capability === 'decision')
        return {
          async decide() {
            return { ok: true, data: { choice: selectedTool, confidence: 1 }, meta };
          },
        };
      if (capability === 'text.model')
        return {
          async complete() {
            completions += 1;
            return {
              ok: true,
              data: {
                text: generatedArgs ? JSON.stringify(generatedArgs) : 'Only the redacted summary',
                tokensIn: 1,
                tokensOut: 1,
              },
              meta,
            };
          },
        };
      throw new Error('Unexpected provider: ' + capability);
    }) as PlaybookContext['provider'],
    callContext(args) {
      return { ...args, runId: 'run_test' };
    },
    async fanOut() {
      throw new Error('Unexpected fanOut');
    },
    async redact() {
      throw new Error('Unexpected redact');
    },
    async judgeCompletion() {
      throw new Error('Unexpected completion judge');
    },
  };
  return {
    context,
    tasks,
    calls,
    approvals,
    outputs,
    failures,
    logs,
    closed,
    announcements,
    results,
    get opened() {
      return opened;
    },
    get completions() {
      return completions;
    },
    selectTool(value: string) {
      selectedTool = value;
    },
    generateArgs(value: Record<string, Json>) {
      generatedArgs = value;
    },
  };
}

let checks = 0;
async function check(label: string, work: () => void | Promise<void>) {
  await work();
  checks += 1;
  console.log('  [PASS] ' + label);
}

await check('legacy agent context excludes completed unrelated branches', async () => {
  const test = fixture();
  await runGraph(
    test.context,
    graph(
      [fetchNode('unrelated', 'NEVER_INCLUDE'), fetchNode('source', 'Relevant evidence'), agent()],
      [edge('source', 'agent')],
    ),
  );
  assert.deepEqual(test.tasks[0]?.context, {
    scope: { source: { source: 'local://test', text: 'Relevant evidence' } },
  });
  assert.doesNotMatch(JSON.stringify(test.tasks), /NEVER_INCLUDE/);
  assert.doesNotMatch(JSON.stringify(test.outputs), /NEVER_INCLUDE|Relevant evidence/);
});

await check(
  'legacy default includes direct predecessors, not their raw ancestors or run variables',
  async () => {
    const test = fixture();
    const summary: GraphNode = {
      id: 'summary',
      type: 'decide',
      label: 'summary',
      position,
      config: { prompt: 'Summarize {{raw.text}}' },
    };
    await runGraph(
      test.context,
      graph(
        [fetchNode('raw', 'RAW_ANCESTOR'), summary, agent()],
        [edge('raw', 'summary'), edge('summary', 'agent')],
      ),
      { variables: { unused: 'UNUSED_INPUT' } },
    );
    assert.deepEqual(test.tasks[0]?.context, {
      scope: { summary: { text: 'Only the redacted summary' } },
    });
    assert.doesNotMatch(JSON.stringify(test.tasks), /RAW_ANCESTOR|UNUSED_INPUT/);
  },
);

await check('explicit contextInputs pass only named values, preserving JSON types', async () => {
  const test = fixture();
  test.results.set('read', { evidence: { count: 2 }, unrelated: 'OMIT_FIELD' });
  await runGraph(
    test.context,
    graph(
      [
        tool('read'),
        agent({
          contextInputs: {
            evidence: '{{read.result.evidence}}',
            limit: '{{input.limit}}',
            enabled: '{{input.enabled}}',
          },
        }),
      ],
      [edge('read', 'agent')],
    ),
    { variables: { limit: 3, enabled: false, unused: 'OMIT_INPUT' } },
  );
  assert.deepEqual(test.tasks[0]?.context, {
    inputs: { evidence: { count: 2 }, limit: 3, enabled: false },
  });
  assert.doesNotMatch(JSON.stringify(test.tasks), /OMIT_FIELD|OMIT_INPUT/);
});

await check('explicit empty contextInputs means no implicit context', async () => {
  const test = fixture();
  await runGraph(
    test.context,
    graph(
      [fetchNode('source', 'OMIT_ALL'), agent({ contextInputs: {} })],
      [edge('source', 'agent')],
    ),
  );
  assert.deepEqual(test.tasks[0]?.context, { inputs: {} });
});

await check('context binding to a transitive ancestor is permitted explicitly', async () => {
  const test = fixture();
  await runGraph(
    test.context,
    graph(
      [
        fetchNode('source', 'Evidence'),
        fetchNode('middle', 'Other'),
        agent({ contextInputs: { evidence: '{{source.text}}' } }),
      ],
      [edge('source', 'middle'), edge('middle', 'agent')],
    ),
  );
  assert.deepEqual(test.tasks[0]?.context, { inputs: { evidence: 'Evidence' } });
});

await check('missing explicit context inputs fail before invoking Hermes', async () => {
  const test = fixture();
  await assert.rejects(
    runGraph(
      test.context,
      graph(
        [
          fetchNode('source', 'Evidence'),
          agent({ contextInputs: { evidence: '{{source.missing}}' } }),
        ],
        [edge('source', 'agent')],
      ),
    ),
    /context input.*evidence.*source.missing/i,
  );
  assert.equal(test.tasks.length, 0);
});

await check('context schema rejects non-reference, self, unknown, and unrelated sources', () => {
  for (const binding of [
    'literal content',
    'prefix {{source.text}}',
    '{{missing.text}}',
    '{{agent.result}}',
    '{{unrelated.text}}',
  ]) {
    const parsed = agentGraphSchema.safeParse(
      draft(
        [
          fetchNode('source', 'ok'),
          fetchNode('unrelated', 'no'),
          agent({ contextInputs: { evidence: binding } }),
        ],
        [edge('source', 'agent')],
      ),
    );
    assert.equal(parsed.success, false, binding);
  }
});

await check(
  'a join excludes skipped predecessors by default and blocks required inputs from them',
  async () => {
    const branch: GraphNode = {
      id: 'branch',
      type: 'judge',
      label: 'branch',
      position,
      config: { question: 'Choose branch', options: ['left', 'right'] },
    };
    const edges = [
      { ...edge('branch', 'left'), sourceHandle: 'left' },
      { ...edge('branch', 'right'), sourceHandle: 'right' },
      edge('left', 'agent'),
      edge('right', 'agent'),
    ];
    for (const required of [false, true]) {
      const test = fixture();
      test.selectTool('left');
      const plan = graph(
        [
          branch,
          fetchNode('left', 'LEFT_EVIDENCE'),
          fetchNode('right', 'RIGHT_EVIDENCE'),
          agent(required ? { contextInputs: { evidence: '{{right.text}}' } } : {}),
        ],
        edges,
      );
      if (required) {
        await assert.rejects(runGraph(test.context, plan), /context input.*evidence.*right.text/i);
        assert.equal(test.tasks.length, 0);
      } else {
        await runGraph(test.context, plan);
        assert.deepEqual(test.tasks[0]?.context, {
          scope: { left: { source: 'local://test', text: 'LEFT_EVIDENCE' } },
        });
      }
    }
  },
);

await check(
  'an unconnected sibling cannot supply a browser session even when it finishes first',
  async () => {
    const test = fixture();
    await assert.rejects(
      runGraph(
        test.context,
        graph(
          [
            fetchNode('unrelated', 'SESSION_FROM_ANOTHER_BRANCH'),
            fetchNode('source', 'ok'),
            tool('extract', { sessionId: '{{unrelated.text}}' }),
          ],
          [edge('source', 'extract')],
        ),
      ),
      /sessionId/,
    );
    assert.equal(test.calls.length, 0);
  },
);

await check(
  'handoff rejects an unresolved inherited session without opening a replacement',
  async () => {
    const test = fixture();
    await assert.rejects(
      runGraph(
        test.context,
        graph([handoff({ sessionId: '{{input.missing}}', url: 'https://example.com' })]),
      ),
      /sessionId/,
    );
    assert.equal(test.opened, 0);
    assert.equal(test.approvals.length, 0);
    assert.deepEqual(test.failures, ['handoff']);
  },
);

await check(
  'handoff without a usable URL or inherited session fails, rather than opening blank',
  async () => {
    const test = fixture();
    await assert.rejects(
      runGraph(test.context, graph([handoff({ url: '{{input.missing}}' })])),
      /sessionId.*url/i,
    );
    assert.equal(test.opened, 0);
  },
);

await check(
  'tools reject null, empty, non-string, and unresolved session IDs before execution',
  async () => {
    for (const sessionId of ['', '   ', null, 5, '{{input.missing}}']) {
      const test = fixture();
      await assert.rejects(
        runGraph(test.context, graph([tool('extract', { sessionId })])),
        /sessionId/,
      );
      assert.equal(test.calls.length, 0);
      assert.deepEqual(test.failures, ['extract']);
    }
  },
);

const dispatch = (
  args: Record<string, Record<string, Json>>,
  argsFrom: 'static' | 'model' = 'static',
): GraphNode => ({
  id: 'dispatch',
  type: 'dispatch',
  label: 'dispatch',
  position,
  config: { goal: 'Choose the next read', candidateTools: ['extract', 'search'], args, argsFrom },
});

await check(
  'dispatch validates only its selected tool, not an unused candidate session ref',
  async () => {
    const test = fixture();
    test.selectTool('search');
    await runGraph(
      test.context,
      graph([
        dispatch({ extract: { sessionId: '{{input.missing}}' }, search: { query: 'example' } }),
      ]),
    );
    assert.deepEqual(test.calls, [{ toolId: 'search', args: { query: 'example' } }]);
  },
);

await check(
  'dispatch cannot repair a missing session reference with a model-invented replacement',
  async () => {
    const test = fixture();
    test.generateArgs({ sessionId: 'invented' });
    await assert.rejects(
      runGraph(
        test.context,
        graph([dispatch({ extract: { sessionId: '{{input.missing}}' } }, 'model')]),
      ),
      /sessionId/,
    );
    assert.equal(test.completions, 0);
    assert.equal(test.calls.length, 0);
  },
);

await check('argument inference cannot override an explicitly bound browser session', async () => {
  const test = fixture();
  test.generateArgs({ sessionId: 'invented', instruction: 'Read heading' });
  await runGraph(
    test.context,
    graph([dispatch({ extract: { sessionId: '{{input.session}}' } }, 'model')]),
    { variables: { session: 'shared_session' } },
  );
  assert.equal(test.calls[0]?.args.sessionId, 'shared_session');
  assert.equal(test.calls[0]?.args.instruction, 'Read heading');
});

await check(
  'open -> human handoff -> extract uses one session and releases it once at run end',
  async () => {
    const test = fixture();
    test.results.set('open', { sessionId: 'shared_session' });
    await runGraph(
      test.context,
      graph(
        [
          tool('open', { url: 'https://example.com' }),
          handoff({ sessionId: '{{open.result.sessionId}}' }),
          tool('extract', { sessionId: '{{handoff.sessionId}}' }),
        ],
        [edge('open', 'handoff'), edge('handoff', 'extract')],
      ),
    );
    assert.equal(test.opened, 0);
    assert.equal(test.approvals.length, 1);
    assert.equal(test.calls[1]?.args.sessionId, 'shared_session');
    assert.deepEqual(test.closed, ['shared_session']);
  },
);

await check(
  'a broken downstream reference still releases the session opened upstream',
  async () => {
    const test = fixture();
    test.results.set('open', { sessionId: 'shared_session' });
    await assert.rejects(
      runGraph(
        test.context,
        graph(
          [
            tool('open', { url: 'https://example.com' }),
            tool('extract', { sessionId: '{{open.sessionId}}' }),
          ],
          [edge('open', 'extract')],
        ),
      ),
      /sessionId/,
    );
    assert.deepEqual(
      test.calls.map((call) => call.toolId),
      ['open'],
    );
    assert.deepEqual(test.closed, ['shared_session']);
  },
);

await check('explicit new-session handoff with a URL still works', async () => {
  const test = fixture();
  await runGraph(test.context, graph([handoff({ url: 'https://example.com' })]));
  assert.equal(test.opened, 1);
  assert.equal(test.approvals.length, 1);
  assert.deepEqual(test.closed, ['new_session']);
});

await check('reference resolution never reads inherited prototype properties', () => {
  assert.equal(lookup({ input: {} }, 'input.constructor'), undefined);
  assert.equal(lookup({ input: {} }, 'input.__proto__'), undefined);
  assert.deepEqual(resolveRefs({ value: '{{input.value}}' }, { input: { value: { count: 3 } } }), {
    value: { count: 3 },
  });
  const result = resolveRefs(JSON.parse('{"__proto__":{"polluted":true},"value":3}'), {});
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.hasOwn(result, '__proto__'), true);
  assert.equal(result.polluted, undefined);
});

console.log('\nALL ' + checks + ' GRAPH CONTEXT CHECKS PASSED');
