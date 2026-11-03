/**
 * Step 1 (milestone M1) contracts check: every coding-agent schema round-trips a valid
 * fixture and rejects an invalid one, RunEvent parsing stays strict about `type`, each
 * mock is deterministic, and POST /api/tasks/_demo drives task.* events onto SSE.
 *
 *   pnpm check:contracts
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import {
  assigneeSchema,
  codingEventSchema,
  evidenceBundleSchema,
  hotFileIntentSchema,
  leaseDecisionSchema,
  leaseSchema,
  nativeToolRequestSchema,
  parseRunEvent,
  preferenceSchema,
  preferenceSignalSchema,
  repoPathSchema,
  RUN_EVENT_TYPES,
  skillProposalSchema,
  skillSchema,
  taskSchema,
  toRepoPath,
  type Assignee,
  type PermissionVerdict,
  type PreferenceSignal,
  type ProviderCallContext,
  type RunEvent,
  type Task,
} from '@htn/shared';
import type { ZodType } from 'zod';

process.env.PERSIST_TO_DISK = 'false';
process.env.MOCK_MIN_LATENCY_MS = '0';
process.env.MOCK_MAX_LATENCY_MS = '0';
process.env.MOCK_FAILURE_RATE = '0';
process.env.NODE_ENV = 'development';

const { createMockHarness, defaultScript } = await import('../src/providers/mockharness/index.js');
const { createMockRouter } = await import('../src/core/decisions/routing.mock.js');
const { InMemorySignalLog } = await import('../src/core/learning/signals.mock.js');
const { createMockLeaseBridge } = await import('../src/core/coordination/leases.mock.js');
const { mockEvidenceBundle } = await import('../src/core/verify/evidence.mock.js');

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (err) {
    console.error('  FAIL ' + name);
    throw err;
  }
}

/** Valid fixture parses and survives a JSON round trip unchanged; invalid one fails. */
function roundTrip(schema: ZodType, valid: unknown, invalid: unknown): void {
  const parsed = schema.parse(valid);
  assert.deepEqual(schema.parse(JSON.parse(JSON.stringify(parsed))), parsed);
  assert.deepEqual(parsed, valid);
  assert.equal(schema.safeParse(invalid).success, false, 'invalid fixture should be rejected');
}

const AT = '2026-01-01T00:00:00.000Z';
const task: Task = {
  id: 'task_1',
  boardRunId: 'run_1',
  title: 'Add rate limiting',
  acceptance: 'Over-limit requests get 429',
  writeScope: ['src/middleware/rateLimit.ts'],
  dependsOn: [],
  status: 'pending',
  createdAt: AT,
  updatedAt: AT,
};
const lease = {
  id: 'lease_1',
  taskId: 'task_1',
  mode: 'write',
  globs: ['src/middleware/**'],
  grantedAt: AT,
  expiresAt: '2026-01-01T00:30:00.000Z',
};
const signal: PreferenceSignal = {
  id: 'sig_1',
  kind: 'variant_pick',
  chosen: 'var_a',
  rejected: ['var_b'],
  scope: 'project',
  private: false,
  at: AT,
};
const preference = {
  id: 'pref_1',
  scope: 'project',
  statement: 'Prefer early returns over nested conditionals',
  confidence: 0.7,
  status: 'candidate',
  evidence: ['sig_1'],
  version: 1,
  createdAt: AT,
  updatedAt: AT,
};

console.log('schemas');

await test('Task round-trips; unknown status rejected', () =>
  roundTrip(taskSchema, task, { ...task, status: 'paused' }));

await test('Assignee round-trips; unknown harness rejected', () =>
  roundTrip(
    assigneeSchema,
    { kind: 'agent', harness: 'codex', tier: 'standard' },
    { kind: 'agent', harness: 'cursor', tier: 'standard' },
  ));

await test('Lease round-trips; empty globs rejected', () =>
  roundTrip(leaseSchema, lease, { ...lease, globs: [] }));

await test('Lease rejects Windows and absolute globs (normalise at the boundary)', () => {
  for (const glob of ['src\\a.ts', '/etc/passwd', 'C:/repo/a.ts', '../outside.ts'])
    assert.equal(leaseSchema.safeParse({ ...lease, globs: [glob] }).success, false, glob);
});

await test('LeaseDecision round-trips; denial without message rejected', () =>
  roundTrip(
    leaseDecisionSchema,
    { allowed: false, reason: 'held_by_other', heldBy: 'task_2', message: 'held by task_2' },
    { allowed: false, reason: 'held_by_other' },
  ));

await test('HotFileIntent round-trips; empty description rejected', () => {
  const intent = {
    id: 'hfi_1',
    taskId: 'task_1',
    path: 'package.json',
    kind: 'add_dependency',
    description: 'add express-rate-limit',
    payload: { name: 'express-rate-limit', version: '^7.0.0' },
    status: 'pending',
    createdAt: AT,
  };
  roundTrip(hotFileIntentSchema, intent, { ...intent, description: '' });
});

await test('NativeToolRequest round-trips; missing sessionId rejected', () => {
  const req = { harness: 'claudecode', toolName: 'Edit', rawInput: { file_path: 'a.ts' }, sessionId: 's1' };
  const { sessionId: _s, ...noSession } = req;
  roundTrip(nativeToolRequestSchema, req, noSession);
});

await test('PreferenceSignal round-trips; variant_pick with nothing rejected is rejected', () =>
  roundTrip(preferenceSignalSchema, signal, { ...signal, rejected: [] }));

await test('Preference round-trips; confidence above 1 rejected', () =>
  roundTrip(preferenceSchema, preference, { ...preference, confidence: 1.5 }));

await test('Skill round-trips; non-kebab name rejected', () => {
  const skill = {
    id: 'skill_1',
    name: 'add-express-middleware',
    description: 'How middleware is added in this repo',
    body: '1. Create src/middleware/x.ts\n2. Register in server.ts',
    scope: 'project',
    status: 'active',
    version: 1,
    evidence: ['sig_1'],
    createdAt: AT,
    updatedAt: AT,
  };
  const parsed = skillSchema.safeParse(skill);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  roundTrip(skillSchema, skill, { ...skill, name: 'Add Middleware' });
});

await test('SkillProposal round-trips; edit without skillId rejected', () => {
  const proposal = skillProposalSchema.parse({
    id: 'sp_1',
    action: 'create',
    name: 'add-express-middleware',
    description: 'How middleware is added',
    body: 'steps',
    scope: 'project',
    relation: { kind: 'new' },
    evidence: ['sig_1'],
    createdAt: AT,
  });
  roundTrip(skillProposalSchema, proposal, { ...proposal, action: 'edit' });
  assert.ok(skillProposalSchema.safeParse({ ...proposal, action: 'edit', skillId: 'skill_1' }).success);
});

await test('EvidenceBundle round-trips; missing diff hash rejected', () => {
  const bundle = mockEvidenceBundle({ runId: 'run_1', taskId: 'task_1', files: ['src/a.ts'] });
  const { hash: _h, ...diffNoHash } = bundle.diff;
  roundTrip(evidenceBundleSchema, bundle, { ...bundle, diff: diffNoHash });
  assert.equal(
    evidenceBundleSchema.safeParse({ ...bundle, diff: { ...bundle.diff, hash: 'not-a-hash' } }).success,
    false,
  );
});

await test('toRepoPath normalises at the boundary', () => {
  assert.equal(toRepoPath('src\\a\\b.ts'), 'src/a/b.ts');
  assert.equal(toRepoPath('./src//a/../b.ts'), 'src/b.ts');
  assert.equal(toRepoPath('C:\\Repo\\src\\a.ts', 'c:\\repo'), 'src/a.ts');
  assert.equal(toRepoPath('/home/me/repo/src/a.ts', '/home/me/repo/'), 'src/a.ts');
  assert.equal(toRepoPath('/etc/passwd', '/home/me/repo'), null);
  assert.equal(toRepoPath('../outside.ts'), null);
  assert.equal(toRepoPath('C:\\elsewhere\\a.ts', 'C:\\repo'), null);
  for (const p of ['src/a/b.ts', 'src/b.ts', 'src/a.ts']) assert.ok(repoPathSchema.safeParse(p).success);
});

console.log('events');

await test('coding events parse; unknown type rejected', () => {
  const events: RunEvent[] = [
    { type: 'task.created', task },
    { type: 'task.updated', task },
    { type: 'task.removed', taskId: 'task_2', at: AT },
    { type: 'task.status', taskId: 'task_1', from: 'pending', to: 'ready', at: AT },
    {
      type: 'task.progress',
      taskId: 'task_1',
      progress: { testsPassed: 1, testsTotal: 3, filesChanged: 2, tokens: 900, turns: 1 },
      at: AT,
    },
    { type: 'lease.granted', lease: leaseSchema.parse(lease) },
    { type: 'lease.denied', taskId: 'task_2', path: 'src/middleware/x.ts', mode: 'write', reason: 'held_by_other', heldBy: 'task_1', at: AT },
    { type: 'lease.extended', lease: leaseSchema.parse(lease), addedGlobs: ['src/routes.ts'] },
    { type: 'lease.expired', leaseId: 'lease_1', taskId: 'task_1', at: AT },
    {
      type: 'intent.updated',
      intent: {
        id: 'int_1',
        taskId: 'task_1',
        path: 'package.json',
        kind: 'add_dependency',
        description: 'add dependency zod@4',
        payload: { name: 'zod', version: '^4.0.0' },
        status: 'applied',
        createdAt: AT,
      },
    },
    { type: 'merge.result', taskId: 'task_1', outcome: 'merged', commit: 'abc123', detail: '3 tests passed', at: AT },
    { type: 'learning.signal', signal },
    { type: 'learning.candidate', candidate: { kind: 'preference', preference: preferenceSchema.parse(preference) } },
    { type: 'learning.activated', entry: 'preference', id: 'pref_1', version: 1, at: AT },
    { type: 'learning.retired', entry: 'skill', id: 'skill_1', reason: 'superseded', at: AT },
    { type: 'harness.turn.ended', runId: 'run_1', sessionId: 's1', turnId: 't1', harness: 'codex', stopReason: 'end_turn', at: AT },
    {
      type: 'gateway.call',
      runId: 'run_1',
      callId: 'gwc_1',
      model: 'claude-opus-5-5',
      status: 200,
      stream: true,
      usage: { inputTokens: 9, outputTokens: 15, cacheCreationInputTokens: 180, cacheReadInputTokens: 4200 },
      costCents: 0.1,
      runCacheHitRate: 0.49,
      toolUses: 1,
      at: AT,
    },
    { type: 'gateway.blocked', runId: 'run_1', reason: 'token_budget', detail: 'run used 4308 of 1000 tokens', at: AT },
    { type: 'workspace.checkpoint', runId: 'run_1', turnId: 't1', ref: 'refs/zephyr/checkpoints/run_1/1', at: AT },
    {
      type: 'verify.tests',
      runId: 'run_1',
      phase: 'after',
      selected: [{ id: 'src/a.test.ts', score: 0.9, fallback: false }],
      source: 'jev',
      tally: { passed: 3, failed: 0, skipped: 0 },
      at: AT,
    },
  ];
  const covered = new Set(events.map((e) => e.type));
  for (const e of events) assert.deepEqual(parseRunEvent(JSON.parse(JSON.stringify(e))), e);
  for (const t of codingEventSchema.options.map((o) => o.shape.type.value))
    assert.ok(covered.has(t), 'no fixture for ' + t);
  assert.throws(() => parseRunEvent({ type: 'task.exploded', taskId: 'task_1' }));
  assert.throws(() => parseRunEvent({ taskId: 'task_1' }));
  // A known coding type with a bad payload is rejected, not waved through as legacy.
  assert.throws(() => parseRunEvent({ type: 'task.status', taskId: 'task_1', to: 'paused', at: AT }));
});

await test('existing event fixtures still parse unchanged', () => {
  const run = {
    id: 'run_1', kind: 'graph', title: 'x', status: 'running', input: {}, createdAt: AT, updatedAt: AT,
  };
  const legacy = [
    { type: 'run.updated', run },
    { type: 'log', runId: 'run_1', level: 'info', message: 'hello', at: AT },
    { type: 'control.decided', runId: 'run_1', decision: { anything: true } },
    { type: 'tool.lifecycle', lifecycle: { phase: 'started', extra: [1, 2] } },
  ];
  for (const e of legacy) assert.deepEqual(parseRunEvent(e), e);
  assert.ok(RUN_EVENT_TYPES.includes('step.upserted') && RUN_EVENT_TYPES.includes('task.created'));
});

console.log('mocks');

await test('mock checkLease is deterministic and allow-all for repo paths', () => {
  const a = createMockLeaseBridge().checkLease('task_1', 'src/a.ts', 'write');
  const b = createMockLeaseBridge().checkLease('task_1', 'src/a.ts', 'write');
  assert.deepEqual(a, b);
  assert.equal(a.allowed, true);
  leaseDecisionSchema.parse(a);
  const bad = createMockLeaseBridge().checkLease('task_1', 'src\\a.ts', 'write');
  assert.equal(bad.allowed, false);
  leaseDecisionSchema.parse(bad);
});

await test('mock routeTask is deterministic and follows its rules', async () => {
  const candidates: Assignee[] = [
    { kind: 'agent', harness: 'codex', tier: 'standard' },
    { kind: 'agent', harness: 'claudecode', tier: 'cheap' },
    { kind: 'agent', harness: 'hermes', tier: 'cheap' },
  ];
  const r1 = await createMockRouter().routeTask(task, candidates);
  const r2 = await createMockRouter().routeTask(task, candidates);
  assert.deepEqual(r1, r2);
  assert.deepEqual(r1, candidates[1], 'small scope → cheapest, ties by order');
  const big = { ...task, writeScope: ['a.ts', 'b.ts', 'c.ts'] };
  assert.deepEqual(await createMockRouter().routeTask(big, candidates), candidates[0]);
  const pinned: Task = { ...task, pinned: true, assignee: { kind: 'agent', harness: 'codex', tier: 'frontier' } };
  assert.deepEqual(await createMockRouter().routeTask(pinned, candidates), pinned.assignee);
  assert.equal((await createMockRouter().routeTask(task, [])).kind, 'human');
});

await test('mock recordSignal is deterministic, validates and logs in order', async () => {
  const runOnce = async () => {
    const log = new InMemorySignalLog();
    await log.recordSignal(signal);
    await log.recordSignal({ ...signal, id: 'sig_2', kind: 'revert', commit: 'abc123' } as PreferenceSignal);
    return log.list();
  };
  const [a, b] = [await runOnce(), await runOnce()];
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((s) => s.id), ['sig_1', 'sig_2']);
  const log = new InMemorySignalLog();
  await assert.rejects(log.recordSignal({ ...signal, rejected: [] }));
  assert.equal(log.list().length, 0);
  await log.recordSignal(signal);
  log.clear();
  assert.equal(log.list().length, 0);
});

await test('mock EvidenceBundle factory is deterministic', () => {
  const input = { runId: 'run_1', taskId: 'task_1', files: ['src/b.ts', 'test/a.test.ts'] };
  const a = mockEvidenceBundle(input);
  assert.deepEqual(a, mockEvidenceBundle({ ...input, files: [...input.files].reverse() }));
  assert.notEqual(a.diff.hash, mockEvidenceBundle({ ...input, files: ['src/c.ts'] }).diff.hash);
  assert.deepEqual(a.tests.modified, ['test/a.test.ts']);
});

await test('mockharness edits a temp dir, asks permission per tool, and is deterministic', async () => {
  const ctx: ProviderCallContext = { runId: 'run_1', policyRule: 'check' };
  const runOnce = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zephyr-contracts-'));
    await writeFile(join(dir, 'README.md'), '# demo\n');
    const asked: string[] = [];
    const leases = createMockLeaseBridge();
    const harness = createMockHarness({
      async decide(req): Promise<PermissionVerdict> {
        nativeToolRequestSchema.parse(req);
        asked.push(req.toolName);
        const path = (req.rawInput as { path?: string }).path;
        if (path === 'src/secret.ts') return 'deny';
        return path ? (leases.checkLease(req.taskId!, toRepoPath(path)!, 'write').allowed ? 'allow' : 'deny') : 'allow';
      },
    });
    const started = await harness.startTask(
      {
        goal: 'Add a greeting',
        context: {
          workspaceDir: dir,
          taskId: 'task_1',
          script: [
            ...defaultScript('Add a greeting'),
            { tool: 'Write', path: 'src/secret.ts', content: 'nope' },
            { tool: 'Write', path: 'src\\nested\\win.ts', content: 'ok' },
          ],
        },
      },
      ctx,
    );
    assert.ok(started.ok);
    let last;
    for (let i = 0; i < 20; i++) {
      last = await harness.pollTask(started.data.taskId, ctx);
      assert.ok(last.ok);
      if (last.data.status !== 'running') break;
    }
    assert.ok(last?.ok);
    const file = await readFile(join(dir, 'src', 'add-a-greeting.ts'), 'utf8');
    const nested = await readFile(join(dir, 'src', 'nested', 'win.ts'), 'utf8');
    const secretExists = await readFile(join(dir, 'src', 'secret.ts'), 'utf8').then(() => true, () => false);
    await harness.dispose();
    await rm(dir, { recursive: true, force: true });
    return { data: last.data, asked, file, nested, secretExists };
  };
  const a = await runOnce();
  const b = await runOnce();
  assert.deepEqual(a, b, 'identical scripts → identical results');
  assert.equal(a.data.status, 'done');
  assert.match(a.file, /done = true/);
  assert.equal(a.nested, 'ok');
  assert.equal(a.secretExists, false, 'denied write must not touch disk');
  assert.deepEqual(a.asked, ['Read', 'Write', 'Edit', 'Bash', 'Write', 'Write']);
  assert.deepEqual((a.data.partial as { filesChanged: string[] }).filesChanged, [
    'src/add-a-greeting.ts',
    'src/nested/win.ts',
  ]);
});

await test('mockharness refuses paths that escape the workspace', async () => {
  const ctx: ProviderCallContext = { runId: 'run_1', policyRule: 'check' };
  const harness = createMockHarness({ decide: async () => 'allow' });
  const started = await harness.startTask(
    { goal: 'escape', context: { script: [{ tool: 'Write', path: '../escape.ts', content: 'x' }] } },
    ctx,
  );
  assert.ok(started.ok);
  const polled = await harness.pollTask(started.data.taskId, ctx);
  assert.ok(polled.ok);
  assert.equal(polled.data.status, 'failed');
  await harness.dispose();
});

console.log('demo board');

const { mountRoutes } = await import('../src/api/index.js');
const { errorHandler } = await import('../src/api/middleware/error.js');
const { establishLocalControl } = await import('../src/services/localControl.js');

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test listener');
  return 'http://127.0.0.1:' + address.port;
}

const app = express();
app.use(express.json());
app.post('/control', (req, res) => {
  establishLocalControl(req, res);
  res.json({ ok: true });
});
mountRoutes(app);
app.use(errorHandler);
const server = createServer(app);
const origin = await listen(server);

await test('POST /api/tasks/_demo streams task events over SSE to completion', async () => {
  const setup = await fetch(origin + '/control', { method: 'POST', headers: { origin } });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const headers = { origin, cookie, 'content-type': 'application/json' };

  const bad = await fetch(origin + '/api/tasks/_demo', { method: 'POST', headers, body: '{"tickMs":-1}' });
  assert.equal(bad.status, 400);

  const res = await fetch(origin + '/api/tasks/_demo', { method: 'POST', headers, body: '{"tickMs":5}' });
  assert.equal(res.status, 202, await res.clone().text());
  const body = (await res.json()) as { runId: string; tasks: Task[] };
  assert.equal(body.tasks.length, 3);
  for (const t of body.tasks) taskSchema.parse(t);
  assert.deepEqual(body.tasks[2]!.dependsOn, [body.tasks[0]!.id, body.tasks[1]!.id]);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const stream = await fetch(origin + '/api/runs/' + body.runId + '/stream', { signal: controller.signal });
  assert.equal(stream.status, 200);
  const events: RunEvent[] = [];
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of stream.body!) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = frame.split('\n').find((l) => l.startsWith('data: '));
        if (data) events.push(parseRunEvent(JSON.parse(data.slice(6))));
      }
      const last = events.at(-1);
      if (last?.type === 'run.updated' && last.run.status !== 'running') break;
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }

  const final = events.at(-1);
  assert.ok(final?.type === 'run.updated', 'stream ended with run.updated');
  assert.equal(final.run.status, 'succeeded', final.run.summary);
  assert.equal(events.filter((e) => e.type === 'task.created').length, 3);
  for (const t of body.tasks) {
    const path = events
      .filter((e): e is Extract<RunEvent, { type: 'task.status' }> => e.type === 'task.status' && e.taskId === t.id)
      .map((e) => e.to);
    assert.deepEqual(path, ['ready', 'running', 'review', 'done'], t.title);
  }
  // Task 3 starts only after both dependencies are done.
  const idxOf = (pred: (e: RunEvent) => boolean) => events.findIndex(pred);
  const t3Ready = idxOf((e) => e.type === 'task.status' && e.taskId === body.tasks[2]!.id && e.to === 'ready');
  for (const dep of body.tasks.slice(0, 2))
    assert.ok(idxOf((e) => e.type === 'task.status' && e.taskId === dep.id && e.to === 'done') < t3Ready);
  for (const type of ['task.progress', 'lease.granted', 'lease.expired', 'harness.turn.ended'] as const)
    assert.equal(events.filter((e) => e.type === type).length >= 3, true, type);
  assert.equal(events.filter((e) => e.type === 'lease.denied').length, 0);
  const result = final.run.result as { evidence: unknown[] };
  assert.equal(result.evidence.length, 3);
  for (const e of result.evidence) evidenceBundleSchema.parse(e);
});

await new Promise<void>((resolve, reject) => {
  server.closeAllConnections();
  server.close((err) => (err ? reject(err) : resolve()));
});

console.log('\ncontracts: ' + passed + ' checks passed');
process.exit(0);
