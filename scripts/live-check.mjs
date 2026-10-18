/**
 * Live-adapter verification. Complements scripts/smoke.mjs, which runs in mock
 * mode and deliberately asserts that nothing is live.
 *
 * WHY THIS EXISTS: withEgress records `result.meta`, never `result.data`. An
 * adapter that returns real usage in `data` only looks completely correct in
 * every unit of code that reads its return value, and still reports ZERO tokens
 * and ZERO cost in the ledger. That class of bug is invisible in mock mode and
 * invisible in typecheck. This script is the check that catches it.
 *
 * Costs real money (one demo run, one cheap-tier completion) and needs a real
 * Hermes install for the agent-task step. Run it deliberately, not in a loop.
 *
 * Usage:  ANTHROPIC_MODE=live HERMES_MODE=live pnpm dev:api   (one terminal)
 *         node scripts/live-check.mjs                          (another)
 *
 * Env: LIVE_BASE (default http://localhost:8787)
 */

const BASE = process.env.LIVE_BASE ?? 'http://localhost:8787';

let failures = 0;

function check(label, condition, detail = '') {
  if (!condition) failures += 1;
  console.log('  [' + (condition ? 'PASS' : 'FAIL') + '] ' + label + (detail ? ' -> ' + detail : ''));
}

function note(label, detail) {
  console.log('  [INFO] ' + label + (detail ? ' -> ' + detail : ''));
}

// Dashboard mutations need the local control cookie and a same-origin header;
// without them run creation is refused (401/403), not a live-adapter failure.
let cookie = '';

async function api(path, init) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      Origin: new URL(BASE).origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function waitFor(runId, predicate, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await api('/api/runs/' + runId);
    if (body?.run && predicate(body.run, body)) return body;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function main() {
  console.log('Live adapter check against ' + BASE + '\n');

  const session = await fetch(BASE + '/api/credentials/session', {
    method: 'POST',
    headers: { Origin: new URL(BASE).origin },
  });
  cookie = session.headers.get('set-cookie')?.split(';')[0] ?? '';
  if (!session.ok || !cookie) {
    console.log('Could not establish a local control session (HTTP ' + session.status + ').');
    process.exit(1);
  }

  console.log('1. Which adapters are actually live');
  const providers = await api('/api/providers');
  const list = providers.body?.providers ?? [];
  const modeOf = (id) => list.find((p) => p.id === id)?.mode;
  note('provider modes', list.map((p) => p.id + '=' + p.mode).join('  '));

  const anthropicLive = modeOf('anthropic') === 'live';
  const hermesLive = modeOf('hermes') === 'live';

  if (!anthropicLive && !hermesLive) {
    console.log('\nNothing is live. Set ANTHROPIC_MODE=live / HERMES_MODE=live and ensure');
    console.log('MOCK_ALL is not set, then re-run. Exiting without failing.');
    process.exit(0);
  }

  console.log('\n2. Run the demo end to end');
  const created = await api('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ kind: 'demo', input: {} }),
  });
  const runId = created.body?.run?.id;
  check('run created', Boolean(runId), runId ?? 'none');
  if (!runId) return finish();

  // Live Hermes can take tens of seconds per turn, so this waits much longer
  // than the mock-mode smoke test does.
  const blocked = await waitFor(runId, (run) => run.status === 'awaiting_approval');
  check('run reached the approval gate', Boolean(blocked), blocked?.run?.status ?? 'timed out');
  if (!blocked) return finish();

  const approval = blocked.approvals.find((a) => a.status === 'pending');
  await api('/api/approvals/' + approval.id + '/decide', {
    method: 'POST',
    body: JSON.stringify({ decision: 'approved' }),
  });

  const done = await waitFor(runId, (run) => run.status === 'succeeded' || run.status === 'failed');
  check('run completed', done?.run?.status === 'succeeded', done?.run?.status ?? 'timed out');

  console.log('\n3. Real usage reached the egress ledger');
  const egress = await api('/api/runs/' + runId + '/egress');
  const rows = egress.body?.events ?? [];

  if (anthropicLive) {
    const calls = rows.filter((e) => e.providerId === 'anthropic' && e.op === 'complete');
    check('an anthropic.complete row exists', calls.length > 0, calls.length + ' rows');
    const call = calls[0];
    check(
      'it went to the real API, not a mock',
      call?.destination === 'https://api.anthropic.com',
      call?.destination ?? 'none',
    );
    // THE assertion this script exists for. Before the fix these were undefined
    // because the adapter put message.usage on `data` and not on `meta`.
    check(
      'real token usage was recorded',
      (call?.tokensIn ?? 0) > 0 && (call?.tokensOut ?? 0) > 0,
      (call?.tokensIn ?? 0) + ' in / ' + (call?.tokensOut ?? 0) + ' out',
    );
    check('a cost was derived from it', (call?.estimatedCostCents ?? 0) > 0,
      (call?.estimatedCostCents ?? 0) + ' cents');
  }

  if (hermesLive) {
    const hermesRows = rows.filter(
      (e) => e.providerId === 'hermes' && !e.destination.startsWith('hermes-internal://'),
    );
    check('hermes adapter calls were logged', hermesRows.length > 0, hermesRows.length + ' rows');

    const agentStep = (done ?? blocked).steps.find((s) => s.kind === 'agent_task');
    check('the live agent task succeeded', agentStep?.status === 'succeeded',
      agentStep?.status ?? 'missing');

    // Documented blind spot, reported rather than asserted: hermes/live.ts's
    // meta() carries no token fields, so a live agent_task contributes nothing
    // to cost. If this ever prints non-zero, ACP started reporting usage and
    // the ledger should start using it.
    const hermesTokens = hermesRows.reduce(
      (sum, e) => sum + (e.tokensIn ?? 0) + (e.tokensOut ?? 0),
      0,
    );
    note('tokens reported by live Hermes', hermesTokens + ' (0 = known blind spot, see hermes/live.ts)');
  }

  console.log('\n4. Analytics reconcile');
  const analytics = await api('/api/runs/' + runId + '/analytics');
  const totals = analytics.body?.totals ?? {};
  check('tokens present in totals', totals.tokensIn > 0,
    totals.tokensIn + ' in / ' + totals.tokensOut + ' out');
  check('cost present in totals', totals.estimatedCostCents > 0,
    totals.estimatedCostCents + ' cents');
  check(
    'no step was dropped from the rollup',
    (analytics.body?.unattributed?.stepIds?.length ?? 0) === totals.stepCount,
    (analytics.body?.unattributed?.stepIds?.length ?? 0) + ' of ' + totals.stepCount,
  );
  note('wall clock', totals.wallMs + 'ms');
  note('provider latency (summed)', totals.providerLatencyMs + 'ms');
  note('parallelism factor', (totals.parallelismFactor ?? 0).toFixed(2) + 'x');

  finish();
}

function finish() {
  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nLive check crashed:', err.message);
  console.error('Is the API running?  pnpm dev:api');
  process.exit(1);
});
