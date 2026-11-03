/**
 * Live coding-benchmark agents. These spend real money: the CLI runs them only with an
 * explicit `--mode live`, and never from a check.
 *
 * Arm (a), vanilla: Claude Code alone, `claude -p <prompt> --output-format json` in
 * the prepared repo, with its own permission mode and no Zephyr in the loop. Token
 * figures come from the CLI's own `usage` block; the cost is its `total_cost_usd`.
 *
 * The Zephyr arms (supervised and the leave-one-out arms) need the model gateway,
 * the hook endpoint and the MCP server of a running Zephyr, bound to the benchmark's
 * temp repo instead of a run worktree. That wiring is not built yet, so asking for a
 * Zephyr arm in live mode fails up front (liveArmProblems) instead of producing
 * numbers that were not measured the way the protocol says.
 */

import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { CodingArmId, CodingTokens } from '@htn/shared';
import type { AgentOutcome, CodingAgent } from '../core/benchmark/coding/index.js';

export const LIVE_ARMS: readonly CodingArmId[] = ['vanilla'];

/** Arms that cannot run live yet, with the reason. Empty means the plan can start. */
export function liveArmProblems(arms: readonly CodingArmId[]): string[] {
  return arms
    .filter((a) => !LIVE_ARMS.includes(a))
    .map((a) => a + ': live Zephyr arms are not wired yet (needs the gateway, hooks and MCP bound to the bench repo)');
}

/** The tools vanilla Claude Code may use without asking: edits plus running node/npm. */
export const VANILLA_ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(node:*)'];

export interface ClaudePrintResult {
  isError: boolean;
  tokens: CodingTokens;
  costUsd: number;
  turns: number;
  text: string;
}

/** Parse `claude -p --output-format json` stdout (the last JSON object printed). */
export function parseClaudePrintJson(stdout: string): ClaudePrintResult {
  const start = stdout.lastIndexOf('\n{') >= 0 ? stdout.lastIndexOf('\n{') + 1 : stdout.indexOf('{');
  if (start < 0) throw new Error('claude printed no JSON result: ' + stdout.slice(-300));
  const raw = JSON.parse(stdout.slice(start)) as {
    is_error?: boolean;
    result?: string;
    num_turns?: number;
    total_cost_usd?: number;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  const u = raw.usage ?? {};
  return {
    isError: raw.is_error === true,
    tokens: {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
    },
    costUsd: raw.total_cost_usd ?? 0,
    turns: raw.num_turns ?? 0,
    text: String(raw.result ?? ''),
  };
}

const quoteWin = (a: string) => (/^[\w./:=@\\-]+$/.test(a) ? a : '"' + a.replace(/"/g, '\\"') + '"');

export interface VanillaAgentOptions {
  /** The `claude` executable; default `claude` on PATH. A `.js`/`.mjs` file runs under this Node. */
  binary?: string;
  model?: string;
  /** Per-run limit; the run is killed and counted as a failure. Default 15 minutes. */
  timeoutMs?: number;
  extraEnv?: Record<string, string>;
}

/** Arm (a): Claude Code alone. */
export function vanillaClaudeAgent(opts: VanillaAgentOptions = {}): CodingAgent {
  const binary = opts.binary ?? 'claude';
  return async ({ task, arm, repoDir, signal }): Promise<AgentOutcome> => {
    if (arm.zephyr) throw new Error('vanillaClaudeAgent runs only the vanilla arm, not ' + arm.id);
    const args = [
      '-p',
      task.prompt,
      '--output-format',
      'json',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      VANILLA_ALLOWED_TOOLS.join(','),
      ...(opts.model ? ['--model', opts.model] : []),
    ];
    const isScript = /\.(c|m)?js$/i.test(binary);
    const cmd = isScript ? process.execPath : binary;
    const argv = isScript ? [binary, ...args] : args;
    // `claude` on Windows is an npm .cmd shim, which Node only runs through a shell.
    const viaShell = process.platform === 'win32' && !isScript && !(isAbsolute(cmd) && /\.exe$/i.test(cmd));
    const stdout = await new Promise<string>((resolvePromise, reject) => {
      const child = viaShell
        ? spawn([cmd, ...argv].map(quoteWin).join(' '), [], { cwd: repoDir, shell: true, windowsHide: true, env: { ...process.env, ...opts.extraEnv } })
        : spawn(cmd, argv, { cwd: repoDir, windowsHide: true, env: { ...process.env, ...opts.extraEnv } });
      let out = '';
      let err = '';
      child.stdout?.on('data', (b: Buffer) => (out += b.toString('utf8')));
      child.stderr?.on('data', (b: Buffer) => (err = (err + b.toString('utf8')).slice(-4000)));
      const kill = () => child.kill('SIGKILL');
      const timer = setTimeout(kill, opts.timeoutMs ?? 15 * 60_000);
      signal.addEventListener('abort', kill, { once: true });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error('could not start claude: ' + e.message));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', kill);
        if (out.includes('{')) resolvePromise(out);
        else reject(new Error('claude exited ' + code + ': ' + (err || out).trim().slice(-600)));
      });
    });
    const parsed = parseClaudePrintJson(stdout);
    // An API error reported by the CLI is a network failure only if its text says so;
    // the runner's isNetworkFailure decides from the message.
    if (parsed.isError && parsed.tokens.output === 0) throw new Error('claude reported an error: ' + parsed.text.slice(0, 600));
    return {
      tokens: parsed.tokens,
      costUsd: parsed.costUsd,
      approvals: 0,
      stuckBlocks: 0,
      detail: 'live: claude -p, ' + parsed.turns + ' turn(s)' + (parsed.isError ? ', ended with an error' : ''),
    };
  };
}
