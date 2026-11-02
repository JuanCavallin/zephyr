/**
 * Step 5, lever L3: tool-schema minimization for the coding harnesses.
 *
 * Every model call carries every tool definition, so a native tool the task can
 * never need is paid for on every turn. The task text is classified ONCE, before
 * the session opens, into a fixed list of Claude Code native tools to disable,
 * and that list is applied at session start (ACP `_meta` options plus the run's
 * `settings.json` deny rules). It is never recomputed mid-session: a tool set
 * that changes between turns invalidates the prompt cache prefix, which costs
 * more than any schema it saves.
 *
 * The classifier is deterministic text matching, with no model call: it runs on
 * the session-start path, and a wrong guess must fail towards MORE tools. When the
 * text is ambiguous the task is an `edit` task, which keeps every editing tool.
 *
 * This is about tokens, not authority. A disabled tool is simply absent; every
 * tool that remains still goes through the permission bridge and
 * `authorize_action` exactly as before.
 */

import { createHash } from 'node:crypto';

export type TaskClass = 'read' | 'edit';

export interface TaskProfile {
  taskClass: TaskClass;
  /** The task names a URL or asks for something on the web. */
  needsWeb: boolean;
  /** The task mentions a Jupyter notebook. */
  needsNotebook: boolean;
}

export interface NativeToolPolicy extends TaskProfile {
  /** Claude Code native tool names to disable, sorted and unique. */
  disallowedTools: string[];
  /** Ignore MCP servers from the worktree's `.mcp.json` and the user config. */
  strictMcpConfig: true;
  /** Short hash of the policy, for logs: equal fingerprints mean an equal tool set. */
  fingerprint: string;
}

/** The native tools L3 may remove. Read, Grep, Glob, LS, Bash and TodoWrite always stay. */
export const NATIVE_TOOL_GROUPS = {
  web: ['WebFetch', 'WebSearch'],
  notebook: ['NotebookEdit'],
  write: ['Edit', 'MultiEdit', 'Write'],
  /**
   * Always removed. A subagent re-sends its own system prompt and tool schemas
   * (the exact cost this lever exists to cut), and Zephyr runs its own parallel
   * steps. Managed runs never enter plan mode, so `ExitPlanMode` is dead weight.
   */
  always: ['ExitPlanMode', 'Task'],
} as const;

const WEB = /\bhttps?:\/\/|\b(?:web\s*(?:site|page|search)?|internet|online|url|urls|browse|download|look\s+up|google)\b/i;
const NOTEBOOK = /\.ipynb\b|\bnotebooks?\b|\bjupyter\b/i;
/** Words that mean the task changes files. Any one of them makes it an `edit` task. */
const EDIT =
  /\b(?:fix(?:es|ed)?|add|adds|implement|change|update|refactor|rename|write|create|remove|delete|replace|edit|modify|migrate|bump|patch|make|build|convert|move|extract|introduce|support|resolve|improve|optimi[sz]e|clean(?:\s*up)?|wire|port|upgrade|generate|rewrite|apply|commit|format|lint|test|tests|install|set\s+up|split|merge|inline|deprecate|document)\b/i;
/** Words that mean the task only asks a question about the code. */
const READ =
  /\b(?:explain|describe|summari[sz]e|review|audit|analy[sz]e|investigate|find|locate|where|why|how\s+does|how\s+do|what|which|list|trace|understand|walk\s+me\s+through|tell\s+me|show\s+me|compare|assess|estimate)\b/i;

export function classifyTask(task: string): TaskProfile {
  const readOnly = READ.test(task) && !EDIT.test(task);
  return {
    taskClass: readOnly ? 'read' : 'edit',
    needsWeb: WEB.test(task),
    needsNotebook: NOTEBOOK.test(task),
  };
}

/** The native-tool policy for `task`. Same task text, same policy, byte for byte. */
export function nativeToolPolicy(task: string): NativeToolPolicy {
  const profile = classifyTask(task);
  const off = new Set<string>(NATIVE_TOOL_GROUPS.always);
  if (!profile.needsWeb) for (const t of NATIVE_TOOL_GROUPS.web) off.add(t);
  if (!profile.needsNotebook || profile.taskClass === 'read') for (const t of NATIVE_TOOL_GROUPS.notebook) off.add(t);
  if (profile.taskClass === 'read') for (const t of NATIVE_TOOL_GROUPS.write) off.add(t);
  const disallowedTools = [...off].sort();
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ disallowedTools, strictMcpConfig: true }))
    .digest('hex')
    .slice(0, 12);
  return { ...profile, disallowedTools, strictMcpConfig: true, fingerprint };
}

/**
 * The ACP `session/new` `_meta` that applies the policy in claude-agent-acp: its
 * `claudeCode.options` are passed to the Claude Agent SDK, whose `disallowedTools`
 * removes those tools from the model's context and whose `extraArgs` become CLI
 * flags (`--strict-mcp-config`, so only the servers sent over ACP are loaded).
 */
export function claudeCodeSessionMeta(policy: NativeToolPolicy): Record<string, unknown> {
  return {
    claudeCode: {
      options: {
        disallowedTools: [...policy.disallowedTools],
        extraArgs: { 'strict-mcp-config': null },
      },
    },
  };
}
