/**
 * Harness-agnostic ACP client: one subprocess, newline-delimited JSON-RPC on
 * stdio, any number of sessions, and a TYPED TERMINAL STATE for every turn.
 *
 * Hermes, Claude Code (via claude-code-acp) and Codex all speak ACP; what
 * differs between them is an AcpHarnessConfig (config.ts). Everything that can
 * go wrong with a peer process lives here, once:
 *
 *   - it never starts           -> AcpError('spawn_failed')
 *   - it never answers          -> 'timeout' (initialize, and per-turn idle)
 *   - it dies mid-turn          -> 'crashed'
 *   - it writes garbage         -> 'protocol_error' (policy: malformedLines)
 *   - it answers with an error  -> 'agent_error'
 *   - we cancel it              -> 'cancelled', and if it ignores session/cancel
 *                                  past the grace period its PROCESS TREE is
 *                                  killed (taskkill /T /F on Windows; the
 *                                  process group on POSIX) — a harness that
 *                                  spawned a test runner must not leave it
 *                                  running.
 *
 * A turn's promise ALWAYS settles. No caller should ever need its own timeout
 * around `prompt()`; if one turns out to be needed, that is a bug here.
 *
 * `session/request_permission` is mapped onto the NativeToolRequest contract
 * and answered with the handler's PermissionVerdict. No handler, a thrown
 * handler, `deny` and `{revise}` all FAIL CLOSED: a reject option, never the
 * last option (which may be an allow).
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type { NativeToolRequest, PermissionVerdict } from '@htn/shared';
import { resolveTimeouts, type AcpHarnessConfig, type AcpTimeouts } from './config.js';

export type AcpFailureReason =
  | 'spawn_failed'
  | 'crashed'
  | 'protocol_error'
  | 'timeout'
  | 'agent_error';

/** How a turn ended. Every `prompt()` resolves to exactly one of these. */
export type AcpTerminal =
  | { kind: 'completed'; stopReason: acp.StopReason }
  | { kind: 'cancelled' }
  | { kind: 'failed'; reason: AcpFailureReason; message: string };

export class AcpError extends Error {
  constructor(
    readonly reason: AcpFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'AcpError';
  }
}

/** A `session/update`, flattened to what callers actually branch on. */
export type AcpEvent =
  | { type: 'text'; text: string; messageId: string | null }
  | {
      type: 'tool_call';
      toolCallId: string;
      /** False for the announcing `tool_call`, true for a `tool_call_update`. */
      isUpdate: boolean;
      title?: string;
      kind?: string;
      status?: string;
      rawInput?: unknown;
    }
  | { type: 'other'; update: acp.SessionUpdate };

export type PermissionHandler = (
  request: NativeToolRequest,
  raw: acp.RequestPermissionRequest,
) => PermissionVerdict | Promise<PermissionVerdict>;

export interface AcpStartOptions {
  harness: AcpHarnessConfig;
  /** Process working directory (sessions get their own cwd). */
  cwd: string;
  /** The complete child env — build it with buildHarnessEnv, never pass process.env. */
  env: Record<string, string>;
  onPermission?: PermissionHandler;
  /** The process went away, for any reason (including our own close()). */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  timeouts?: Partial<AcpTimeouts>;
  /** Peer stderr. Default 'inherit' so the harness's own logs stay visible. */
  stderr?: 'inherit' | 'ignore';
  log?: (message: string) => void;
}

const ALLOW_KINDS = ['allow_once', 'allow_always'] as const;
const REJECT_KINDS = ['reject_once', 'reject_always'] as const;

/** Fail closed: a reject option, else cancel. Never falls back to an arbitrary option. */
export function denyPermission(
  options: readonly { optionId: string; kind?: string }[],
): { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } {
  for (const kind of REJECT_KINDS) {
    const option = options.find((o) => o.kind === kind);
    if (option) return { outcome: 'selected', optionId: option.optionId };
  }
  return { outcome: 'cancelled' };
}

/** Allow once if offered, else allow always; with no allow option, cancel. */
export function allowPermission(
  options: readonly { optionId: string; kind?: string }[],
): { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } {
  for (const kind of ALLOW_KINDS) {
    const option = options.find((o) => o.kind === kind);
    if (option) return { outcome: 'selected', optionId: option.optionId };
  }
  return { outcome: 'cancelled' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Kill a process and everything it spawned. On Windows `child.kill()` only
 * terminates the direct child — a harness's test runner or dev server would
 * survive it — so the tree goes through `taskkill /T /F`. On POSIX the child
 * was started as a process-group leader (`detached`), so the group is killed.
 */
export async function killProcessTree(child: ChildProcess, waitMs = 5_000): Promise<void> {
  const pid = child.pid;
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((r) => child.once('exit', () => r()));
  if (pid !== undefined) {
    if (process.platform === 'win32') {
      await new Promise<void>((r) =>
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => r()),
      );
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  }
  await Promise.race([exited, sleep(waitMs)]);
}

interface Turn {
  promise: Promise<AcpTerminal>;
  settle(terminal: AcpTerminal): void;
  settled: boolean;
  cancelRequested: boolean;
}

export class AcpSession {
  private turn: Turn | null = null;
  private broken: string | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private idlePaused = 0;

  constructor(
    private readonly client: AcpClient,
    private readonly active: acp.ActiveSession,
    private readonly timeouts: AcpTimeouts,
  ) {}

  get sessionId(): string {
    return this.active.sessionId;
  }

  get busy(): boolean {
    return this.turn !== null;
  }

  /**
   * Send a prompt and drain the turn. `onEvent` sees every update in order;
   * the returned promise settles exactly once, with a typed terminal state.
   */
  prompt(text: string, onEvent?: (event: AcpEvent) => void): Promise<AcpTerminal> {
    if (this.turn) throw new AcpError('agent_error', 'A turn is already running on this session.');
    const unusable = this.broken ?? this.client.deadReason();
    if (unusable) return Promise.resolve({ kind: 'failed', reason: 'crashed', message: unusable });

    let settle!: (t: AcpTerminal) => void;
    const turn: Turn = {
      promise: new Promise<AcpTerminal>((r) => (settle = r)),
      settled: false,
      cancelRequested: false,
      settle: (terminal) => {
        if (turn.settled) return;
        turn.settled = true;
        this.clearIdle();
        if (this.turn === turn) this.turn = null;
        settle(terminal);
      },
    };
    this.turn = turn;
    this.armIdle();

    // Rejections surface through nextUpdate(); this catch only stops an
    // unhandled-rejection warning for the same error.
    this.active.prompt(text).catch(() => {});
    void this.drain(turn, onEvent);
    return turn.promise;
  }

  private async drain(turn: Turn, onEvent?: (event: AcpEvent) => void): Promise<void> {
    try {
      for (;;) {
        const message = await this.active.nextUpdate();
        if (turn.settled) return;
        this.armIdle();
        if (message.kind === 'stop') {
          turn.settle(
            message.stopReason === 'cancelled' || turn.cancelRequested
              ? { kind: 'cancelled' }
              : { kind: 'completed', stopReason: message.stopReason },
          );
          return;
        }
        if (onEvent) {
          try {
            onEvent(toEvent(message.update));
          } catch (err) {
            this.client.log('onEvent handler threw: ' + (err as Error).message);
          }
        }
      }
    } catch (err) {
      if (turn.settled) return;
      // stdout usually closes a moment before 'exit' fires; wait for the exit
      // code so a crash is reported with it.
      await this.client.awaitExit(250);
      if (turn.settled) return;
      turn.settle(this.client.classify(err, turn.cancelRequested));
    }
  }

  /**
   * Ask the peer to stop the turn. If it has not stopped within the grace
   * period, the whole process tree is killed and the turn ends `cancelled`.
   */
  async cancel(opts: { graceMs?: number } = {}): Promise<AcpTerminal> {
    const turn = this.turn;
    const graceMs = opts.graceMs ?? this.timeouts.cancelGraceMs;
    if (turn) turn.cancelRequested = true;
    await this.client.notifyCancel(this.sessionId);
    if (!turn) return { kind: 'cancelled' };
    if (graceMs > 0) await Promise.race([turn.promise, sleep(graceMs)]);
    if (!turn.settled) {
      this.client.log('peer ignored session/cancel; killing its process tree');
      await this.client.close();
      turn.settle({ kind: 'cancelled' });
    }
    return turn.promise;
  }

  /** Stop routing updates. Ends an active turn as cancelled. */
  dispose(): void {
    this.active.dispose();
    this.turn?.settle({ kind: 'cancelled' });
    this.client.forget(this);
  }

  /** @internal Fail the active turn from outside (crash, protocol error, close). */
  fail(terminal: AcpTerminal): void {
    const turn = this.turn;
    if (!turn) return;
    turn.settle(turn.cancelRequested && terminal.kind === 'failed' ? { kind: 'cancelled' } : terminal);
  }

  /** @internal The permission handler is ours to wait on, not the peer being idle. */
  pauseIdle(): void {
    this.idlePaused++;
    this.clearIdle();
  }

  /** @internal */
  resumeIdle(): void {
    this.idlePaused = Math.max(0, this.idlePaused - 1);
    if (this.turn) this.armIdle();
  }

  private armIdle(): void {
    this.clearIdle();
    const ms = this.timeouts.turnIdleMs;
    const turn = this.turn;
    if (!turn || ms <= 0 || this.idlePaused > 0) return;
    this.idleTimer = setTimeout(() => {
      if (turn.settled) return;
      // The peer may still be working; tell it to stop, and never reuse a
      // session whose queue may still deliver this turn's late updates.
      this.broken = 'Session abandoned after an idle timeout.';
      void this.client.notifyCancel(this.sessionId);
      turn.settle({
        kind: 'failed',
        reason: 'timeout',
        message: 'No update from the agent for ' + ms + 'ms.',
      });
    }, ms);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

function toEvent(update: acp.SessionUpdate): AcpEvent {
  if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
    return { type: 'text', text: update.content.text, messageId: update.messageId ?? null };
  }
  if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    return {
      type: 'tool_call',
      toolCallId: update.toolCallId,
      isUpdate: update.sessionUpdate === 'tool_call_update',
      title: update.title ?? undefined,
      kind: update.kind ?? undefined,
      status: update.status ?? undefined,
      rawInput: update.rawInput,
    };
  }
  return { type: 'other', update };
}

export class AcpClient {
  readonly harness: AcpHarnessConfig;
  readonly timeouts: AcpTimeouts;
  agentInfo: acp.InitializeResponse['agentInfo'] = null;

  private conn!: acp.ClientConnection;
  private readonly sessions = new Map<string, AcpSession>();
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private exitPromise: Promise<void>;
  private streamEnded = false;
  private protocolError: string | null = null;
  private closing: Promise<void> | null = null;
  private readonly logFn: (m: string) => void;

  private constructor(
    private readonly child: ChildProcess,
    private readonly opts: AcpStartOptions,
  ) {
    this.harness = opts.harness;
    this.timeouts = resolveTimeouts(opts.harness.timeouts, opts.timeouts);
    this.logFn = opts.log ?? ((m) => console.error('[acp:' + opts.harness.harness + '] ' + m));
    this.exitPromise = new Promise<void>((r) => {
      const done = (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.exitInfo) return;
        this.exitInfo = { code, signal };
        r();
      };
      child.once('exit', done);
    });
  }

  /** Spawn the harness and complete `initialize`. Throws AcpError on any failure. */
  static async start(opts: AcpStartOptions): Promise<AcpClient> {
    const { harness } = opts;
    // NOT shell:true: argv is passed through without quoting, and cmd.exe
    // resolution broke under `tsx watch` (see hermes/live.ts history).
    const child = spawn(harness.binary, harness.args, {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', opts.stderr ?? 'inherit'],
      // A process-group leader on POSIX, so cancel can kill the whole tree.
      detached: process.platform !== 'win32',
    });

    // spawn() returning says nothing about whether the process started; an
    // unhandled 'error' event would take the whole API server down.
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', () => {
          child.removeListener('error', reject);
          resolve();
        });
      });
    } catch (err) {
      throw new AcpError(
        'spawn_failed',
        'Could not start ' + harness.binary + ': ' + (err as Error).message,
      );
    }

    const client = new AcpClient(child, opts);
    client.wire();
    try {
      await client.initialize();
    } catch (err) {
      await client.close();
      throw err instanceof AcpError ? err : new AcpError('agent_error', (err as Error).message);
    }
    return client;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Null while usable; otherwise why not. */
  deadReason(): string | null {
    if (this.protocolError) return this.protocolError;
    if (this.closing) return 'ACP client closed.';
    if (this.exitInfo) return this.describeExit();
    return null;
  }

  log(message: string): void {
    this.logFn(message);
  }

  /** @internal Resolve when the process has exited, or after `ms`. */
  async awaitExit(ms: number): Promise<void> {
    if (this.exitInfo) return;
    await Promise.race([this.exitPromise, sleep(ms)]);
  }

  private describeExit(): string {
    const e = this.exitInfo;
    return (
      this.harness.binary +
      ' exited' +
      (e ? ' (code ' + e.code + (e.signal ? ', signal ' + e.signal : '') + ')' : '') +
      '.'
    );
  }

  private wire(): void {
    const child = this.child;
    child.on('exit', (code, signal) => {
      this.log(this.harness.binary + ' exited (code ' + code + ')');
      this.opts.onExit?.(code, signal);
      // Let stdout drain first: a peer that writes its stop and exits must end
      // `completed`, not `crashed`.
      setTimeout(() => this.failAll({ kind: 'failed', reason: 'crashed', message: this.describeExit() }), 250).unref();
    });
    // A LATER error (dies mid-session) must not crash the server either.
    child.on('error', (err) => this.log('process error: ' + err.message));
    // The peer closing stdin early is an exit, reported above; not a crash of ours.
    child.stdin?.on('error', () => {});

    const decoder = new TextDecoder();
    let buffer = '';
    const policy = this.harness.malformedLines ?? 'fail';
    const inspect = (line: string) => {
      try {
        JSON.parse(line);
      } catch {
        const shown = line.length > 120 ? line.slice(0, 120) + '...' : line;
        if (policy === 'ignore') {
          this.log('ignoring a non-JSON line from the agent: ' + shown);
          return;
        }
        this.protocolError = 'Agent wrote a malformed JSON-RPC line: ' + shown;
        this.failAll({ kind: 'failed', reason: 'protocol_error', message: this.protocolError });
        void this.close();
      }
    };
    const inspector = new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) inspect(line);
        }
        controller.enqueue(chunk);
      },
      flush: () => {
        this.streamEnded = true;
      },
    });

    const output = (Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>).pipeThrough(inspector);
    const input = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;

    this.conn = acp
      .client({ name: 'zephyr-' + this.harness.harness })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this.answerPermission(ctx.params),
      )
      .connect(acp.ndJsonStream(input, output));
  }

  private async answerPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const session = this.sessions.get(params.sessionId);
    const handler = this.opts.onPermission;
    session?.pauseIdle();
    try {
      if (!handler) {
        this.log('denied a native permission request: no permission handler is configured');
        return { outcome: denyPermission(params.options) };
      }
      const verdict = await handler(
        {
          harness: this.harness.harness,
          toolName: nativeToolName(params.toolCall),
          rawInput: params.toolCall.rawInput ?? null,
          sessionId: params.sessionId,
          toolCallId: params.toolCall.toolCallId,
          ...(params.toolCall.kind ? { kind: params.toolCall.kind } : {}),
        },
        params,
      );
      return {
        outcome: verdict === 'allow' ? allowPermission(params.options) : denyPermission(params.options),
      };
    } catch (err) {
      this.log('permission handler threw; denying: ' + (err as Error).message);
      return { outcome: denyPermission(params.options) };
    } finally {
      session?.resumeIdle();
    }
  }

  private async initialize(): Promise<void> {
    const response = await this.guard(
      this.conn.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      }),
      this.timeouts.initializeMs,
      'initialize',
    );
    this.agentInfo = response.agentInfo ?? null;
    const pinned = this.harness.pinnedVersion;
    if (pinned && this.agentInfo?.version !== pinned) {
      this.log(
        'version drift: expected ' + pinned + ', agent reports ' + (this.agentInfo?.version ?? 'none'),
      );
    }
  }

  /** Open a session. `meta` becomes `_meta` on `session/new`. */
  async newSession(opts: {
    cwd: string;
    meta?: Record<string, unknown>;
    mcpServers?: acp.McpServer[];
  }): Promise<AcpSession> {
    const dead = this.deadReason();
    if (dead) throw new AcpError('crashed', dead);
    const request = this.conn.agent.buildSession(opts.cwd).toRequest();
    if (opts.mcpServers) request.mcpServers = opts.mcpServers;
    if (opts.meta) request._meta = opts.meta;
    const active = await this.guard(
      this.conn.agent.buildSession(request).start(),
      this.timeouts.initializeMs,
      'session/new',
    );
    const session = new AcpSession(this, active, this.timeouts);
    this.sessions.set(session.sessionId, session);
    return session;
  }

  /**
   * Race a request against a timeout and the process exiting, mapping every
   * outcome to an AcpError with a reason.
   */
  private async guard<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout =
      timeoutMs > 0
        ? new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new AcpError('timeout', what + ' timed out after ' + timeoutMs + 'ms.')),
              timeoutMs,
            );
          })
        : new Promise<never>(() => {});
    const exited = this.exitPromise.then(() => {
      throw new AcpError('crashed', this.describeExit() + ' during ' + what);
    });
    try {
      return await Promise.race([promise, timeout, exited]);
    } catch (err) {
      if (err instanceof AcpError) throw err;
      const terminal = this.classify(err, false);
      throw new AcpError(
        terminal.kind === 'failed' ? terminal.reason : 'agent_error',
        what + ': ' + (err as Error).message,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** @internal Turn a rejection from the connection into a terminal state. */
  classify(err: unknown, cancelRequested: boolean): AcpTerminal {
    if (cancelRequested || this.closing) return { kind: 'cancelled' };
    if (this.protocolError)
      return { kind: 'failed', reason: 'protocol_error', message: this.protocolError };
    if (this.exitInfo || this.streamEnded || this.conn.signal.aborted)
      return {
        kind: 'failed',
        reason: 'crashed',
        message: this.exitInfo ? this.describeExit() : 'Agent closed the connection.',
      };
    return { kind: 'failed', reason: 'agent_error', message: (err as Error)?.message ?? String(err) };
  }

  /** @internal Best effort: a dead peer cannot be told anything. */
  async notifyCancel(sessionId: string): Promise<void> {
    if (this.deadReason()) return;
    try {
      await this.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId });
    } catch (err) {
      this.log('session/cancel failed: ' + (err as Error).message);
    }
  }

  /** @internal */
  forget(session: AcpSession): void {
    this.sessions.delete(session.sessionId);
  }

  private failAll(terminal: AcpTerminal): void {
    for (const session of this.sessions.values()) session.fail(terminal);
  }

  /** End every turn (as cancelled), close the connection, kill the process tree. Idempotent. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.failAll({ kind: 'cancelled' });
      try {
        this.conn?.close();
      } catch {
        // already closed
      }
      if (!this.exitInfo) await killProcessTree(this.child);
    })();
    return this.closing;
  }
}

/**
 * The harness's own tool name for a permission request. Claude Code's ACP adapter
 * carries it in `_meta.claudeCode.toolName`; the title ("Edit `a.ts`", "`git push`")
 * is a human label and only the fallback. Descriptors never trust either for safety.
 */
function nativeToolName(toolCall: acp.RequestPermissionRequest['toolCall']): string {
  const meta = (toolCall as { _meta?: unknown })._meta;
  if (meta && typeof meta === 'object') {
    const cc = (meta as Record<string, unknown>).claudeCode;
    if (cc && typeof cc === 'object') {
      const name = (cc as Record<string, unknown>).toolName;
      if (typeof name === 'string' && name.length > 0) return name;
    }
  }
  return toolCall.title ?? toolCall.kind ?? 'unknown';
}
