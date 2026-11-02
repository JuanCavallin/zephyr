/**
 * Coding-agent control plane contracts (spec docs/coding-agent-control-plane.md §15,
 * "Day 0 contracts"; step doc docs/cacp-01-contracts-and-mocks.md).
 *
 * Every cross-stream interface for the task board, leases, native-tool permission,
 * learning loop and evidence lives here as a zod schema, with its TypeScript type
 * derived via `z.infer`. ADDITIVE ONLY: these are seams between four owners. Change a
 * shape only after telling the owner on the other side of it.
 *
 * Browser-safe: no Node built-ins, no config, no secrets.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

const id = z.string().min(1);
const iso = z.iso.datetime();
const count = z.number().int().nonnegative();
const unit = z.number().min(0).max(1);

/**
 * A repo-relative, POSIX-style path or glob: `apps/web/**`, `package.json`.
 *
 * The schema VALIDATES and never transforms. Windows paths are normalised at the
 * boundary that receives them (see `toRepoPath`), so a backslash reaching a schema is
 * a bug at that boundary and is rejected here rather than silently repaired.
 */
export const repoPathSchema = z
  .string()
  .min(1)
  .refine((p) => !p.includes('\\'), 'must use forward slashes')
  .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p), 'must be repo-relative')
  .refine((p) => !p.split('/').includes('..'), 'must not escape the repo');
export type RepoPath = z.infer<typeof repoPathSchema>;

/**
 * Boundary helper: turn a path a harness or OS handed us into a `RepoPath`, or `null`
 * when it is outside the repo. Pure string work so it runs in the browser too.
 *
 * @param path absolute or relative, either slash style
 * @param repoRoot absolute repo root, either slash style; omit when `path` is already relative
 */
export function toRepoPath(path: string, repoRoot?: string): RepoPath | null {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const isAbsolute = (p: string) => p.startsWith('/') || /^[A-Za-z]:/.test(p);
  let p = norm(path);
  if (repoRoot) {
    const root = norm(repoRoot).replace(/\/+$/, '');
    const caseless = /^[A-Za-z]:/.test(root); // Windows drive paths compare caselessly
    const [a, b] = caseless ? [p.toLowerCase(), root.toLowerCase()] : [p, root];
    if (a.startsWith(b + '/')) p = p.slice(root.length + 1);
    else if (isAbsolute(p)) return null;
  } else if (isAbsolute(p)) return null;
  const segments: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segments.length === 0) return null;
      segments.pop();
    } else segments.push(seg);
  }
  const out = segments.join('/');
  return repoPathSchema.safeParse(out).success ? out : null;
}

/** Harnesses the control plane can drive. `mockharness` is the deterministic test double. */
export const harnessIdSchema = z.enum(['claudecode', 'codex', 'hermes', 'mockharness']);
export type HarnessId = z.infer<typeof harnessIdSchema>;

/** Mirrors `ModelTier` in providers.ts. */
export const modelTierSchema = z.enum(['local', 'cheap', 'standard', 'frontier']);

/* -------------------------------------------------------------------------- */
/* Tasks                                                                      */
/* -------------------------------------------------------------------------- */

/** `pending → ready → running → review → done`, plus `blocked` and `failed` (spec §10). */
export const taskStatusSchema = z.enum([
  'pending',
  'ready',
  'running',
  'review',
  'done',
  'blocked',
  'failed',
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export const TASK_STATUSES = taskStatusSchema.options;

/** Who does a task: a harness at a model tier, or "needs a human" (spec §10 Routing). */
export const assigneeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('agent'),
    harness: harnessIdSchema,
    tier: modelTierSchema,
    /** Concrete model id when the route is pinned to one. */
    model: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal('human'), reason: z.string().min(1).optional() }),
]);
export type Assignee = z.infer<typeof assigneeSchema>;

/** Derived by Zephyr from what it observed, never self-reported by the agent. */
export const taskProgressSchema = z.object({
  testsPassed: count,
  testsTotal: count,
  filesChanged: count,
  tokens: count,
  turns: count,
});
export type TaskProgress = z.infer<typeof taskProgressSchema>;

export const taskSchema = z.object({
  id,
  /** The graph run the board is a view over. Task events are emitted on it. */
  boardRunId: id,
  title: z.string().min(1),
  acceptance: z.string().min(1),
  /** Estimated write scope; becomes the write lease's globs when the task runs. */
  writeScope: z.array(repoPathSchema),
  dependsOn: z.array(id),
  status: taskStatusSchema,
  assignee: assigneeSchema.optional(),
  /** Set when the user pinned the assignee; routing must then return it. */
  pinned: z.boolean().optional(),
  /** The run executing this task, once it has started. */
  runId: id.optional(),
  branch: z.string().min(1).optional(),
  progress: taskProgressSchema.optional(),
  /** Why the task is `blocked` or `failed`. */
  reason: z.string().min(1).optional(),
  createdAt: iso,
  updatedAt: iso,
});
export type Task = z.infer<typeof taskSchema>;

/* -------------------------------------------------------------------------- */
/* Leases and hot-file intents                                                */
/* -------------------------------------------------------------------------- */

export const leaseModeSchema = z.enum(['read', 'write']);
export type LeaseMode = z.infer<typeof leaseModeSchema>;

/** A write lease a running task holds over its globs (spec §10 Leases). */
export const leaseSchema = z.object({
  id,
  taskId: id,
  mode: leaseModeSchema,
  globs: z.array(repoPathSchema).min(1),
  grantedAt: iso,
  expiresAt: iso,
});
export type Lease = z.infer<typeof leaseSchema>;

export const leaseDenyReasonSchema = z.enum([
  /** The task holds a lease, but not over this path. */
  'outside_lease',
  /** Another task's lease covers this path. */
  'held_by_other',
  /** Hot files are never leased; submit a HotFileIntent instead. */
  'hot_file',
  /** The task has no live lease (never granted, or expired). */
  'no_lease',
  /** The path is outside the repo or not a valid RepoPath. */
  'invalid_path',
]);
export type LeaseDenyReason = z.infer<typeof leaseDenyReasonSchema>;

export const leaseDecisionSchema = z.discriminatedUnion('allowed', [
  z.object({ allowed: z.literal(true), leaseId: id.optional(), reason: z.string().min(1) }),
  z.object({
    allowed: z.literal(false),
    reason: leaseDenyReasonSchema,
    /** Task holding the conflicting lease, for `held_by_other`. */
    heldBy: id.optional(),
    message: z.string().min(1),
  }),
]);
export type LeaseDecision = z.infer<typeof leaseDecisionSchema>;

/**
 * What an agent submits instead of editing a hot file (`package.json`, lockfiles,
 * route registries, barrel `index.ts`, shared schemas). Applied in order by a
 * serialized integrator step.
 */
export const hotFileIntentSchema = z.object({
  id,
  taskId: id,
  path: repoPathSchema,
  kind: z.enum(['add_dependency', 'register_route', 'export_symbol', 'edit_schema', 'other']),
  /** Human-readable: "add dependency zod@3". */
  description: z.string().min(1),
  /** Structured detail the integrator applies, e.g. `{ name: 'zod', version: '3' }`. */
  payload: z.json().optional(),
  status: z.enum(['pending', 'applied', 'rejected']),
  createdAt: iso,
});
export type HotFileIntent = z.infer<typeof hotFileIntentSchema>;

/* -------------------------------------------------------------------------- */
/* Native tool permission                                                     */
/* -------------------------------------------------------------------------- */

/** A native tool the harness wants to run (ACP `session/request_permission`, a hook, …). */
export const nativeToolRequestSchema = z.object({
  harness: harnessIdSchema,
  /** The harness's own tool name: `Bash`, `Edit`, `Write`, `Read`, `WebFetch`, … */
  toolName: z.string().min(1),
  /** Exactly what the harness sent. Untrusted; descriptors parse it. */
  rawInput: z.unknown(),
  sessionId: id,
  /** The harness's id for this call, when it has one. */
  toolCallId: z.string().min(1).optional(),
  /** ACP `ToolKind` (`read`, `edit`, `execute`, …) when the harness sent one. A hint only. */
  kind: z.string().min(1).optional(),
  /** Set by Zephyr (never by the harness) when the session runs a board task. */
  taskId: id.optional(),
});
export type NativeToolRequest = z.infer<typeof nativeToolRequestSchema>;

/** What `onPermissionRequest` resolves to. `revise` hands the harness a corrected input. */
export type PermissionVerdict = 'allow' | 'deny' | { revise: unknown };

/* -------------------------------------------------------------------------- */
/* Learning loop                                                              */
/* -------------------------------------------------------------------------- */

export const learningScopeSchema = z.enum(['personal', 'project']);
export type LearningScope = z.infer<typeof learningScopeSchema>;

const signalBase = {
  id,
  taskId: id.optional(),
  runId: id.optional(),
  scope: learningScopeSchema,
  /** From a private-route run: only a local model may process it (spec §11 Guardrails). */
  private: z.boolean(),
  at: iso,
};

/** One observation about what the user wants, strongest kinds first (spec §11). */
export const preferenceSignalSchema = z.discriminatedUnion('kind', [
  z.object({
    ...signalBase,
    kind: z.literal('user_edit'),
    /** Hash of the diff between agent output and what got merged. */
    diffHash: z.string().min(1),
    files: z.array(repoPathSchema).min(1),
  }),
  z.object({
    ...signalBase,
    kind: z.literal('variant_pick'),
    chosen: id,
    rejected: z.array(id).min(1),
  }),
  z.object({
    ...signalBase,
    kind: z.literal('approval'),
    approvalId: id,
    outcome: z.enum(['rejected', 'revised']),
    comment: z.string().min(1).optional(),
  }),
  z.object({ ...signalBase, kind: z.literal('revert'), commit: z.string().min(1) }),
  z.object({
    ...signalBase,
    kind: z.literal('explicit_feedback'),
    rating: z.enum(['up', 'down']),
    comment: z.string().min(1).optional(),
  }),
  z.object({ ...signalBase, kind: z.literal('request_wording'), text: z.string().min(1) }),
]);
export type PreferenceSignal = z.infer<typeof preferenceSignalSchema>;
export type PreferenceSignalKind = PreferenceSignal['kind'];

const learnedEntryStatus = z.enum(['candidate', 'active', 'retired']);

/** A short statement with evidence: "prefers no new dependencies". */
export const preferenceSchema = z.object({
  id,
  scope: learningScopeSchema,
  statement: z.string().min(1),
  confidence: unit,
  status: learnedEntryStatus,
  /** Signal ids. Every entry keeps links to its evidence. */
  evidence: z.array(id).min(1),
  version: z.number().int().positive(),
  createdAt: iso,
  updatedAt: iso,
});
export type Preference = z.infer<typeof preferenceSchema>;

/** A procedure, emitted as `.claude/skills/<name>/SKILL.md` for project scope. */
export const skillSchema = z.object({
  id,
  scope: learningScopeSchema,
  name: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'kebab-case'),
  description: z.string().min(1),
  body: z.string().min(1),
  status: learnedEntryStatus,
  evidence: z.array(id).min(1),
  version: z.number().int().positive(),
  createdAt: iso,
  updatedAt: iso,
});
export type Skill = z.infer<typeof skillSchema>;

/** How a candidate relates to existing entries (Jev's `choice`, spec §11 step 3). */
export const learnedRelationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('new') }),
  z.object({ kind: z.literal('duplicate'), of: id }),
  z.object({ kind: z.literal('contradicts'), of: id }),
]);
export type LearnedRelation = z.infer<typeof learnedRelationSchema>;

/** A drafted skill change awaiting scoring and (for project scope) a PR. */
export const skillProposalSchema = z
  .object({
    id,
    scope: learningScopeSchema,
    action: z.enum(['create', 'edit', 'retire']),
    /** Required for `edit` and `retire`. */
    skillId: id.optional(),
    name: skillSchema.shape.name,
    description: z.string().min(1),
    body: z.string().min(1),
    evidence: z.array(id).min(1),
    /** Jev `probability` that the evidence supports it; absent until scored. */
    support: unit.optional(),
    relation: learnedRelationSchema.optional(),
    createdAt: iso,
  })
  .refine((p) => p.action === 'create' || p.skillId !== undefined, {
    message: 'edit and retire proposals need skillId',
    path: ['skillId'],
  });
export type SkillProposal = z.infer<typeof skillProposalSchema>;

/* -------------------------------------------------------------------------- */
/* Evidence                                                                   */
/* -------------------------------------------------------------------------- */

const usageSchema = z.object({
  tokensIn: count,
  tokensOut: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  costCents: z.number().nonnegative(),
  wallMs: count,
});

const testTallySchema = z.object({ passed: count, failed: count, skipped: count });

/** `evidence.json` for a run that reached `done` (spec §3 Evidence bundle). */
export const evidenceBundleSchema = z.object({
  id,
  runId: id,
  taskId: id.optional(),
  diff: z.object({
    files: count,
    insertions: count,
    deletions: count,
    /** Hex sha1 (git) or sha256 of the diff. `git.publish` approvals bind to it. */
    hash: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, 'hex sha1 or sha256'),
  }),
  checkpoints: z.array(z.object({ turnId: id, ref: z.string().min(1), at: iso })),
  tests: z.object({
    selected: z.array(
      z.object({
        id,
        /** Jev relevance score; absent when the deterministic fallback chose it. */
        score: unit.optional(),
        fallback: z.boolean(),
      }),
    ),
    before: testTallySchema.optional(),
    after: testTallySchema,
    added: z.array(repoPathSchema),
    modified: z.array(repoPathSchema),
  }),
  protectedPathApprovals: z.array(z.object({ path: repoPathSchema, approvalId: id })),
  walkthrough: z
    .object({
      previewUrl: z.url(),
      steps: z.array(
        z.object({ description: z.string().min(1), screenshotUrl: z.string().min(1).optional() }),
      ),
    })
    .optional(),
  usage: usageSchema,
  baseline: usageSchema.optional(),
  egress: z.object({ calls: count, destinations: z.array(z.string().min(1)) }),
  createdAt: iso,
});
export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;

/* -------------------------------------------------------------------------- */
/* Model gateway accounting (step 4, docs/cacp-04-model-gateway.md)           */
/* -------------------------------------------------------------------------- */

/**
 * One Anthropic Messages call's usage, split the way Anthropic bills it. The four
 * counts are disjoint: `inputTokens` is the UNCACHED input only, so total input is
 * `inputTokens + cacheCreationInputTokens + cacheReadInputTokens`.
 */
export const gatewayUsageSchema = z.object({
  inputTokens: count,
  outputTokens: count,
  cacheCreationInputTokens: count,
  cacheReadInputTokens: count,
});
export type GatewayUsage = z.infer<typeof gatewayUsageSchema>;

export const gatewayBlockReasonSchema = z.enum(['token_budget', 'cost_budget']);
export type GatewayBlockReason = z.infer<typeof gatewayBlockReasonSchema>;

/* -------------------------------------------------------------------------- */
/* Events (members of RunEvent in events.ts)                                  */
/* -------------------------------------------------------------------------- */

export const codingEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('task.created'), task: taskSchema }),
  z.object({
    type: z.literal('task.status'),
    taskId: id,
    from: taskStatusSchema.optional(),
    to: taskStatusSchema,
    reason: z.string().min(1).optional(),
    assignee: assigneeSchema.optional(),
    at: iso,
  }),
  z.object({
    type: z.literal('task.progress'),
    taskId: id,
    progress: taskProgressSchema,
    at: iso,
  }),
  z.object({ type: z.literal('lease.granted'), lease: leaseSchema }),
  z.object({
    type: z.literal('lease.denied'),
    taskId: id,
    path: z.string().min(1),
    mode: leaseModeSchema,
    reason: leaseDenyReasonSchema,
    heldBy: id.optional(),
    at: iso,
  }),
  z.object({
    type: z.literal('lease.extended'),
    lease: leaseSchema,
    addedGlobs: z.array(repoPathSchema).min(1),
  }),
  z.object({ type: z.literal('lease.expired'), leaseId: id, taskId: id, at: iso }),
  z.object({ type: z.literal('learning.signal'), signal: preferenceSignalSchema }),
  z.object({
    type: z.literal('learning.candidate'),
    candidate: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('preference'), preference: preferenceSchema }),
      z.object({ kind: z.literal('skill'), proposal: skillProposalSchema }),
    ]),
  }),
  z.object({
    type: z.literal('learning.activated'),
    entry: z.enum(['preference', 'skill']),
    id,
    version: z.number().int().positive(),
    at: iso,
  }),
  z.object({
    type: z.literal('learning.retired'),
    entry: z.enum(['preference', 'skill']),
    id,
    reason: z.string().min(1),
    at: iso,
  }),
  /** One `/v1/messages` call through the gateway, after its usage is known. */
  z.object({
    type: z.literal('gateway.call'),
    runId: id,
    callId: id,
    model: z.string().min(1).optional(),
    status: z.number().int(),
    stream: z.boolean(),
    usage: gatewayUsageSchema,
    /** Absent when the model has no known price; never a guessed 0. */
    costCents: z.number().nonnegative().optional(),
    /** Run-level cache hit rate after this call, 0..1. */
    runCacheHitRate: unit,
    toolUses: count,
    error: z.object({ type: z.string().min(1), message: z.string() }).optional(),
    at: iso,
  }),
  /** The gateway refused to forward a call. The harness got an error, never silence. */
  z.object({
    type: z.literal('gateway.blocked'),
    runId: id,
    reason: gatewayBlockReasonSchema,
    detail: z.string().min(1),
    at: iso,
  }),
  /** Claude Code `Stop` hook / ACP end-of-turn. `harness.turn` covers in-turn phases. */
  z.object({
    type: z.literal('harness.turn.ended'),
    runId: id,
    sessionId: id,
    turnId: id,
    harness: harnessIdSchema,
    stopReason: z.enum(['end_turn', 'max_tokens', 'cancelled', 'refusal', 'error']),
    taskId: id.optional(),
    at: iso,
  }),
]);
export type CodingEvent = z.infer<typeof codingEventSchema>;
export type CodingEventType = CodingEvent['type'];
export const CODING_EVENT_TYPES = codingEventSchema.options.map(
  (o) => o.shape.type.value,
) as CodingEventType[];

/* -------------------------------------------------------------------------- */
/* Integration seams (spec §15) — one function each, agreed on day 0          */
/* -------------------------------------------------------------------------- */

/**
 * Permission bridge, Person 1 → Person 3. The broker asks whether `taskId` may touch
 * `path` before authorizing a native fs action. Synchronous: it runs on every tool call.
 * `path` is a RepoPath; callers normalise with `toRepoPath` first.
 */
export interface PermissionBridgeSeam {
  checkLease(taskId: string, path: string, mode: LeaseMode): LeaseDecision;
}

/**
 * Routing, Person 3's scheduler → Person 2. Picks one of `candidates` (or a human).
 * Must return a pinned assignee unchanged when `task.pinned` is set.
 */
export interface RoutingSeam {
  routeTask(task: Task, candidates: Assignee[]): Promise<Assignee>;
}

/**
 * Signals, Person 3's merge queue and Person 4's variant picker → Person 2's signal log.
 * Fire and forget from the caller's side: learning is off the critical path.
 */
export interface SignalSeam {
  recordSignal(s: PreferenceSignal): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Token levers (step 5) — run policy, default on                             */
/* -------------------------------------------------------------------------- */

/**
 * The three token levers a coding run applies. Each is independently switchable so
 * a run can be measured with and without it; all default on.
 *
 * - `shapedTools` (L1): raw test/build/lint shell commands are denied with a pointer
 *   to `zephyr_run_tests` / `zephyr_build` / `zephyr_lint`, which return a digest.
 * - `contextPack` (L2): the first prompt carries a ranked file map plus the top
 *   files' text, so the agent does not spend turns exploring.
 * - `schemaMin` (L3): strict MCP config and a per-task-class native tool disable
 *   list, chosen once at session start so tool definitions stay byte-stable.
 */
export const leversSchema = z.object({
  shapedTools: z.boolean(),
  contextPack: z.boolean(),
  schemaMin: z.boolean(),
});
export type Levers = z.infer<typeof leversSchema>;

export const DEFAULT_LEVERS: Levers = Object.freeze({
  shapedTools: true,
  contextPack: true,
  schemaMin: true,
}) as Levers;

/** Defaults with any explicitly set lever overriding them. */
export function resolveLevers(partial?: Partial<Levers> | null): Levers {
  return { ...DEFAULT_LEVERS, ...Object.fromEntries(Object.entries(partial ?? {}).filter(([, v]) => typeof v === 'boolean')) };
}
