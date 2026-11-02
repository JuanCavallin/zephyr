/**
 * Native coding-agent tools as exact actions.
 *
 * A harness's own tools (Claude Code's Read/Edit/Bash, Hermes's terminal/write_file,
 * …) are mapped to six descriptors from the spec table so the broker can reason
 * about them like any other tool:
 *
 * | Native action                               | Descriptor   | Reversibility | Default  |
 * |---------------------------------------------|--------------|---------------|----------|
 * | Read/grep/glob inside the worktree          | `fs.read`    | n/a           | auto     |
 * | Edit/write inside the worktree              | `fs.write`   | reversible    | auto     |
 * | Read/write outside the worktree             | `fs.*`       | irreversible  | deny     |
 * | Shell: allow-listed inspect/verify          | `shell.exec` | reversible    | auto     |
 * | Shell: install, network, unknown            | `shell.exec` | irreversible  | approval |
 * | `git commit` in the worktree                | `git.commit` | reversible    | auto     |
 * | `git push`, PR create, merge                | `git.publish`| irreversible  | approval on (branch, diff hash) |
 * | Web fetch                                   | `http.fetch` | read          | policy   |
 *
 * Reversibility and effect are derived HERE, server-side, from the parsed input —
 * never taken from the harness. A tool this module cannot map throws
 * `UnmappedToolError`, which the permission bridge turns into a deny.
 */

import { createHash } from 'node:crypto';
import type {
  ActionPolicy,
  DataLabel,
  Json,
  NativeToolRequest,
  Reversibility,
  ToolDescriptor,
  ToolEffect,
} from '@htn/shared';
import { containPath, type ContainmentContext } from './pathContainment.js';
import { classifyShell, parseShell, type ShellClassification } from './shellClassifier.js';

export type NativeToolId =
  | 'fs.read'
  | 'fs.write'
  | 'shell.exec'
  | 'git.commit'
  | 'git.publish'
  | 'http.fetch'
  | 'agent.internal';

export const NATIVE_DESCRIPTOR_VERSION = '1';
export const NATIVE_TOOL_IDS: NativeToolId[] = [
  'fs.read',
  'fs.write',
  'shell.exec',
  'git.commit',
  'git.publish',
  'http.fetch',
  'agent.internal',
];

export type NativeMapContext = ContainmentContext;

/** One native call, mapped. `defaultPolicy` is the spec-table default for this row. */
export interface ExactAction {
  toolId: NativeToolId;
  descriptor: ToolDescriptor;
  operation: string;
  arguments: Json;
  destination: string;
  dataLabels: DataLabel[];
  defaultPolicy: ActionPolicy;
  reasonCodes: string[];
  /** The harness's own tool name, normalized (`Bash`, `Edit`, `terminal`, …). */
  nativeTool: string;
  shell?: ShellClassification;
}

export class UnmappedToolError extends Error {
  readonly code = 'UNMAPPED_NATIVE_TOOL';
  constructor(
    readonly toolName: string,
    readonly detail: string,
  ) {
    super('Unmapped native tool ' + JSON.stringify(toolName) + ': ' + detail);
    this.name = 'UnmappedToolError';
  }
}

/* -------------------------------------------------------------------------- */
/* Descriptors                                                                */
/* -------------------------------------------------------------------------- */

const FAMILY: Record<NativeToolId, string> = {
  'fs.read': 'native.fs',
  'fs.write': 'native.fs',
  'shell.exec': 'native.shell',
  'git.commit': 'native.git',
  'git.publish': 'native.git',
  'http.fetch': 'native.http',
  'agent.internal': 'native.agent',
};

const DESCRIPTION: Record<NativeToolId, string> = {
  'fs.read': 'Read, list or search files',
  'fs.write': 'Create or edit a file',
  'shell.exec': 'Run a shell command',
  'git.commit': 'Commit in the run worktree',
  'git.publish': 'Push a branch or open/merge a pull request',
  'http.fetch': 'Fetch a URL or run a web search',
  'agent.internal': "Harness-internal bookkeeping (todos, subagents) or Zephyr's own MCP tools",
};

/**
 * The descriptor for one call. Effect and reversibility depend on the call (a write
 * inside the worktree is reversible by checkpoint, one outside is not), so the
 * descriptor is built per action rather than looked up from a static table.
 */
export function nativeDescriptor(
  id: NativeToolId,
  shape: { effect: ToolEffect; reversibility: Reversibility; requiresChangeReview?: boolean },
): ToolDescriptor {
  return {
    id,
    version: NATIVE_DESCRIPTOR_VERSION,
    providerId: 'native',
    family: FAMILY[id],
    interactionMode: 'interactive',
    description: DESCRIPTION[id],
    inputSchemaRef: 'native:' + id,
    transport: 'harness',
    baselineEffect: shape.effect,
    reversibility: shape.reversibility,
    requiredScopes: [],
    allowedDataLabels: ['public', 'private'],
    availability: 'available',
    executorRef: 'harness:native',
    ...(shape.requiresChangeReview ? { requiresChangeReview: true } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Tool-name normalization                                                    */
/* -------------------------------------------------------------------------- */

type NativeKind = 'read' | 'write' | 'shell' | 'fetch' | 'search' | 'internal';

/** Exact names (lowercased) → kind. Claude Code first, then Hermes. */
const KNOWN_TOOLS: Record<string, NativeKind> = {
  read: 'read',
  glob: 'read',
  grep: 'read',
  ls: 'read',
  notebookread: 'read',
  write: 'write',
  edit: 'write',
  multiedit: 'write',
  notebookedit: 'write',
  bash: 'shell',
  powershell: 'shell',
  webfetch: 'fetch',
  websearch: 'search',
  todowrite: 'internal',
  todoread: 'internal',
  task: 'internal',
  agent: 'internal',
  exitplanmode: 'internal',
  bashoutput: 'internal',
  killshell: 'internal',
  killbash: 'internal',
  taskoutput: 'internal',
  // Hermes
  terminal: 'shell',
  read_file: 'read',
  search_files: 'read',
  write_file: 'write',
  patch: 'write',
  web_search: 'search',
  web_extract: 'fetch',
  todo: 'internal',
};

/** ACP `ToolKind` → native kind. `other`/`think`/`switch_mode` are not inferable. */
const ACP_KINDS: Record<string, NativeKind> = {
  read: 'read',
  search: 'read',
  edit: 'write',
  delete: 'write',
  move: 'write',
  execute: 'shell',
  fetch: 'fetch',
};

/** Zephyr's own MCP server: those calls are brokered again by the MCP gateway. */
const ZEPHYR_MCP_PREFIX = 'mcp__zephyr__';

function input(req: NativeToolRequest): Record<string, unknown> {
  const raw = req.rawInput;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeName(name: string): string {
  // Claude Code's ACP adapter exposes its own fs tools as `mcp__acp__Edit` etc.
  return name.trim().replace(/^mcp__acp__/i, '');
}

function resolveKind(req: NativeToolRequest): { kind: NativeKind; name: string } {
  const name = normalizeName(req.toolName);
  if (name.toLowerCase().startsWith(ZEPHYR_MCP_PREFIX)) return { kind: 'internal', name };
  if (name.toLowerCase().startsWith('mcp__')) {
    throw new UnmappedToolError(req.toolName, 'MCP tools outside the Zephyr gateway are not brokered');
  }
  const exact = KNOWN_TOOLS[name.toLowerCase()];
  if (exact) return { kind: exact, name };

  // ACP titles are human strings ("Write permitted.txt", "`git status`"). Take the
  // first word only when it is itself a known tool name.
  const first = /^[A-Za-z_]+/.exec(name)?.[0]?.toLowerCase();
  if (first && KNOWN_TOOLS[first]) return { kind: KNOWN_TOOLS[first]!, name: first };

  const fields = input(req);
  if (name.startsWith('`') && str(fields.command)) return { kind: 'shell', name: 'Bash' };

  const acpKind = req.kind ? ACP_KINDS[req.kind] : undefined;
  if (acpKind && req.kind) return { kind: acpKind, name: req.kind };

  throw new UnmappedToolError(req.toolName, 'no descriptor for this tool name or kind');
}

/* -------------------------------------------------------------------------- */
/* mapNativeTool                                                              */
/* -------------------------------------------------------------------------- */

const LABELS: DataLabel[] = ['private'];

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function worktreeDestination(relative: string): string {
  return 'local://worktree/' + relative;
}

function targetPath(fields: Record<string, unknown>): string | undefined {
  return str(fields.file_path) ?? str(fields.notebook_path) ?? str(fields.path);
}

function mapFs(
  op: 'read' | 'write',
  nativeTool: string,
  fields: Record<string, unknown>,
  ctx: NativeMapContext,
): ExactAction {
  const target = targetPath(fields) ?? (op === 'read' ? '.' : undefined);
  if (!target) throw new UnmappedToolError(nativeTool, 'write without a target path');
  const contained = containPath(target, ctx);
  const toolId: NativeToolId = op === 'read' ? 'fs.read' : 'fs.write';

  if (!contained.inside) {
    return {
      toolId,
      descriptor: nativeDescriptor(toolId, {
        effect: op === 'read' ? 'read' : 'write',
        reversibility: 'irreversible',
      }),
      operation: op,
      arguments: { tool: nativeTool, path: target },
      destination: 'file://' + (contained.resolved ?? target),
      dataLabels: LABELS,
      defaultPolicy: 'deny',
      reasonCodes: ['fs-outside-worktree', contained.reason],
      nativeTool,
    };
  }

  if (op === 'write' && contained.protectedSegment) {
    return {
      toolId,
      descriptor: nativeDescriptor(toolId, { effect: 'write', reversibility: 'irreversible' }),
      operation: op,
      arguments: { tool: nativeTool, path: contained.relative! },
      destination: worktreeDestination(contained.relative!),
      dataLabels: LABELS,
      defaultPolicy: 'deny',
      reasonCodes: ['fs-write-protected-path'],
      nativeTool,
    };
  }

  const args: Record<string, Json> = { tool: nativeTool, path: contained.relative || '.' };
  if (op === 'read' && str(fields.pattern)) args.pattern = str(fields.pattern)!;
  if (op === 'write') {
    // Hash, not content: the action is identified exactly without copying the file
    // body into every trace event.
    const body = JSON.stringify([
      fields.content ?? null,
      fields.old_string ?? null,
      fields.new_string ?? null,
      fields.edits ?? null,
      fields.new_source ?? null,
      fields.patch ?? null,
    ]);
    args.contentSha256 = sha256(body);
  }
  return {
    toolId,
    descriptor: nativeDescriptor(toolId, {
      effect: op === 'read' ? 'read' : 'write',
      reversibility: 'reversible',
    }),
    operation: op,
    arguments: args,
    destination: worktreeDestination(contained.relative || '.'),
    dataLabels: LABELS,
    defaultPolicy: 'auto',
    reasonCodes: [op === 'read' ? 'fs-read-in-worktree' : 'fs-write-in-worktree-checkpointed'],
    nativeTool,
  };
}

/** `git push …`, `gh pr create|merge …`, anywhere in the command. */
const PUBLISH_PATTERN = /\bgit\b[^\n]*\bpush\b|\bgh\s+pr\s+(create|merge)\b/;

function publishOperation(command: string): string | null {
  if (!PUBLISH_PATTERN.test(command)) return null;
  if (/\bgh\s+pr\s+merge\b/.test(command)) return 'pr.merge';
  if (/\bgh\s+pr\s+create\b/.test(command)) return 'pr.create';
  return 'push';
}

function mapShell(nativeTool: string, fields: Record<string, unknown>, ctx: NativeMapContext): ExactAction {
  const command = str(fields.command);
  if (!command) throw new UnmappedToolError(nativeTool, 'shell call without a command');
  const platform = nativeTool.toLowerCase() === 'powershell' ? 'win32' : ctx.platform;
  const shell = classifyShell(command, { worktree: ctx.worktree, platform });

  const publish = publishOperation(command);
  if (publish) {
    return {
      toolId: 'git.publish',
      descriptor: nativeDescriptor('git.publish', {
        effect: 'write',
        reversibility: 'irreversible',
        requiresChangeReview: true,
      }),
      operation: publish,
      arguments: { tool: nativeTool, command },
      destination: 'git://remote',
      dataLabels: LABELS,
      defaultPolicy: 'ask_user',
      reasonCodes: ['git-publish-requires-exact-approval'],
      nativeTool,
      shell,
    };
  }

  const parsed = parseShell(command, platform);
  const single = parsed.ok && parsed.stages.length === 1 ? parsed.stages[0] : undefined;
  if (single && single.argv[0] === 'git' && single.argv[1] === 'commit' && shell.class !== 'unknown') {
    return {
      toolId: 'git.commit',
      descriptor: nativeDescriptor('git.commit', { effect: 'write', reversibility: 'reversible' }),
      operation: 'commit',
      arguments: { tool: nativeTool, command },
      destination: 'local://worktree/.git',
      dataLabels: LABELS,
      defaultPolicy: 'auto',
      reasonCodes: ['git-commit-in-worktree'],
      nativeTool,
      shell,
    };
  }

  const safe = shell.class === 'inspect' || shell.class === 'verify';
  return {
    toolId: 'shell.exec',
    descriptor: nativeDescriptor('shell.exec', {
      effect: shell.class === 'inspect' ? 'read' : 'write',
      reversibility: safe ? 'reversible' : 'irreversible',
    }),
    operation: 'exec',
    arguments: { tool: nativeTool, command, class: shell.class },
    destination: safe ? 'local://worktree' : 'local://host',
    dataLabels: LABELS,
    defaultPolicy: safe ? 'auto' : 'ask_user',
    reasonCodes: ['shell-' + shell.class, shell.reason],
    nativeTool,
    shell,
  };
}

function mapFetch(
  kind: 'fetch' | 'search',
  nativeTool: string,
  fields: Record<string, unknown>,
): ExactAction {
  const url =
    str(fields.url) ?? (Array.isArray(fields.urls) && typeof fields.urls[0] === 'string' ? fields.urls[0] : undefined);
  const query = str(fields.query);
  let destination = 'https://web-search';
  if (kind === 'fetch') {
    if (!url) throw new UnmappedToolError(nativeTool, 'fetch without a URL');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new UnmappedToolError(nativeTool, 'fetch URL does not parse');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new UnmappedToolError(nativeTool, 'fetch of a non-HTTP URL');
    }
    destination = parsed.protocol + '//' + parsed.host;
  }
  return {
    toolId: 'http.fetch',
    descriptor: nativeDescriptor('http.fetch', { effect: 'read', reversibility: 'reversible' }),
    operation: kind,
    arguments: { tool: nativeTool, ...(url ? { url } : {}), ...(query ? { query } : {}) },
    destination,
    dataLabels: LABELS,
    defaultPolicy: 'auto',
    reasonCodes: ['http-fetch-egress-ledgered'],
    nativeTool,
  };
}

export function mapNativeTool(req: NativeToolRequest, ctx: NativeMapContext): ExactAction {
  const { kind, name } = resolveKind(req);
  const fields = input(req);
  switch (kind) {
    case 'read':
      return mapFs('read', name, fields, ctx);
    case 'write':
      return mapFs('write', name, fields, ctx);
    case 'shell':
      return mapShell(name, fields, ctx);
    case 'fetch':
    case 'search':
      return mapFetch(kind, name, fields);
    case 'internal':
      return {
        toolId: 'agent.internal',
        descriptor: nativeDescriptor('agent.internal', { effect: 'read', reversibility: 'reversible' }),
        operation: 'internal',
        arguments: { tool: name },
        destination: 'local://harness',
        dataLabels: LABELS,
        defaultPolicy: 'auto',
        reasonCodes: [
          name.toLowerCase().startsWith(ZEPHYR_MCP_PREFIX)
            ? 'zephyr-mcp-brokered-at-gateway'
            : 'harness-internal-tool',
        ],
        nativeTool: name,
      };
  }
}
