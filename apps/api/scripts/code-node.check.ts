/**
 * check:code-node — the `code` graph node and its sandbox. Offline: a scripted
 * text.model double, real child processes under Node's permission model.
 *
 *   pnpm --filter @htn/api check:code-node
 */
import assert from 'node:assert/strict';
import { agentGraphSchema, type AgentGraph, type Step } from '@htn/shared';
import { runGraph, stripCodeFence } from '../src/core/graph/interpreter.js';
import { runInSandbox, SANDBOX_MAX_OUTPUT_BYTES } from '../src/core/sandbox/codeSandbox.js';
import type { PlaybookContext } from '../src/core/playbooks/types.js';

let checks = 0;
async function check(label: string, work: () => void | Promise<void>) {
  await work();
  checks += 1;
  console.log('  [PASS] ' + label);
}

/* ---------------------------------------------------------------- sandbox */

await check('authored source gets inputs on stdin and returns its JSON result', async () => {
  const r = await runInSandbox(
    'let s="";for await(const c of process.stdin)s+=c;const {inputs}=JSON.parse(s);console.log(JSON.stringify({sum:inputs.a+inputs.b}))',
    { inputs: { a: 2, b: 3 } },
  );
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.result, { sum: 5 });
});

await check('network, subprocesses and files outside the scratch dir are denied', async () => {
  const probe = `
const out = {};
try { await fetch('http://127.0.0.1:9/'); out.net = 'open'; } catch { out.net = 'denied'; }
try { (await import('node:child_process')).execSync('echo hi'); out.proc = 'open'; } catch { out.proc = 'denied'; }
try { (await import('node:fs')).readFileSync(process.platform === 'win32' ? 'C:/Windows/win.ini' : '/etc/passwd'); out.fs = 'open'; } catch { out.fs = 'denied'; }
try { (await import('node:fs')).writeFileSync('escape.txt', 'x'); out.write = 'open'; } catch { out.write = 'denied'; }
console.log(JSON.stringify(out));`;
  const r = await runInSandbox(probe);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.result, { net: 'denied', proc: 'denied', fs: 'denied', write: 'denied' });
});

await check('the parent environment (secrets) is not inherited', async () => {
  process.env.ZEPHYR_CODE_CHECK_SECRET = 'hunter2';
  const r = await runInSandbox('console.log(JSON.stringify({ v: process.env.ZEPHYR_CODE_CHECK_SECRET ?? null }))');
  delete process.env.ZEPHYR_CODE_CHECK_SECRET;
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.result, { v: null });
});

await check('a runaway script is killed at the timeout', async () => {
  const r = await runInSandbox('while (true) {}', { timeoutMs: 800 });
  assert.equal(r.ok, false);
  assert.equal(r.failure, 'timeout');
});

await check('a non-zero exit reports stderr; no JSON reports no-result', async () => {
  const bad = await runInSandbox('throw new Error("boom")');
  assert.equal(bad.failure, 'exit');
  assert.match(bad.error ?? '', /boom/);
  const none = await runInSandbox('console.log("not json")');
  assert.equal(none.failure, 'no-result');
});

await check('output past the cap is cut off', async () => {
  const r = await runInSandbox(`console.log("x".repeat(${SANDBOX_MAX_OUTPUT_BYTES * 2}))`);
  assert.equal(r.failure, 'output-too-large');
});

await check('older Node is refused, because --permission would leave the network open', async () => {
  const r = await runInSandbox('console.log("1")', { nodeMajor: 22 });
  assert.equal(r.failure, 'unsupported');
});

await check('stripCodeFence takes the fenced block and passes plain code through', () => {
  assert.equal(stripCodeFence('Here:\n```js\nconsole.log(1)\n```\nDone'), 'console.log(1)');
  assert.equal(stripCodeFence('console.log(2)'), 'console.log(2)');
});

/* ------------------------------------------------------------ graph node */

const at = '2026-11-03T00:00:00Z';
const codeGraph = (config: Record<string, unknown>): AgentGraph =>
  agentGraphSchema.parse({
    id: 'graph_code',
    name: 'code',
    version: 1,
    createdAt: at,
    updatedAt: at,
    nodes: [{ id: 'code', type: 'code', label: 'Compute', position: { x: 0, y: 0 }, config }],
    edges: [],
  });

function context(modelText: string) {
  const prompts: string[] = [];
  const outputs: unknown[] = [];
  let n = 0;
  const meta = { provider: 'anthropic' as const, mode: 'mock' as const, op: 't', latencyMs: 0, destination: null };
  const ctx = {
    runId: 'run_test',
    signal: new AbortController().signal,
    async log() {},
    async step(spec: { label: string; kind?: string; nodeId?: string }, work: (s: Step) => Promise<unknown>) {
      const out = await work({ ...spec, id: 'step_' + ++n } as unknown as Step);
      outputs.push(out);
      return out;
    },
    providerFor: () => 'anthropic',
    provider: () => ({
      async complete(req: { prompt: string }) {
        prompts.push(req.prompt);
        return { ok: true, data: { text: modelText, tokensIn: 1, tokensOut: 1 }, meta };
      },
    }),
    callContext: (a: object) => ({ ...a, runId: 'run_test' }),
  } as unknown as PlaybookContext;
  return { ctx, prompts, outputs };
}

await check('schema: a code node needs only a goal and defaults the rest', () => {
  const g = codeGraph({ goal: 'sum the numbers' });
  const cfg = (g.nodes[0] as { config: { inputs: unknown; language: string } }).config;
  assert.deepEqual(cfg.inputs, {});
  assert.equal(cfg.language, 'javascript');
  assert.throws(() => codeGraph({}), /goal/);
});

await check('authored source runs with no model call', async () => {
  const t = context('SHOULD NOT BE USED');
  await runGraph(
    t.ctx,
    codeGraph({
      goal: 'double x',
      source: 'let s="";for await(const c of process.stdin)s+=c;console.log(JSON.stringify(JSON.parse(s).inputs.x*2))',
      inputs: { x: 21 },
    }),
  );
  assert.equal(t.prompts.length, 0);
  assert.deepEqual((t.outputs[0] as { result: unknown; generated: boolean }).result, 42);
  assert.equal((t.outputs[0] as { generated: boolean }).generated, false);
});

await check('without source, code is generated from the goal and input KEYS only, then run', async () => {
  const t = context('```js\nconsole.log(JSON.stringify({ ok: true }))\n```');
  await runGraph(t.ctx, codeGraph({ goal: 'report ok', inputs: { secretValue: 'hunter2' } }));
  assert.equal(t.prompts.length, 1);
  assert.match(t.prompts[0]!, /report ok/);
  assert.match(t.prompts[0]!, /secretValue/);
  assert.doesNotMatch(t.prompts[0]!, /hunter2/, 'input values must not reach the model');
  const out = t.outputs[0] as { result: unknown; generated: boolean };
  assert.deepEqual(out.result, { ok: true });
  assert.equal(out.generated, true);
});

await check('a failing script fails the run loudly, naming the node', async () => {
  const t = context('throw new Error("bad generated code")');
  await assert.rejects(runGraph(t.ctx, codeGraph({ goal: 'x' })), /Code node "Compute" failed \(exit\).*bad generated code/);
});

console.log(`\n${checks} checks passed`);
