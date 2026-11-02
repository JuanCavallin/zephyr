/**
 * Step 5, lever L1: shaped test/build/lint tools, exposed over the Zephyr MCP
 * server like every other registered tool (the harness sees them as
 * `mcp__zephyr__zephyr_run_tests` and so on).
 *
 * Policy: the three runners are `write` + `reversible`, which the deterministic
 * policy resolves to `verify` (they run project code, so they are not plain reads,
 * and the executor confirms a result). `zephyr_test_output` is a `read` → `auto`.
 * Nothing here bypasses the broker: each call is authorized like any other tool.
 */

import type { Json, ToolDescriptor } from '@htn/shared';
import type { InMemoryToolExecutorRegistry, ToolExecutionOutput } from '../executors.js';
import type { InMemoryToolRegistry } from '../registry.js';
import type { ShapedKind } from './commands.js';
import { OutputStore } from './outputStore.js';
import { runShaped, type ShapedRunConfig } from './runTests.js';
import { runWorktrees, type RunWorktrees } from './worktrees.js';

export const SHAPED_TOOL_IDS = {
  test: 'zephyr.run_tests',
  build: 'zephyr.build',
  lint: 'zephyr.lint',
  output: 'zephyr.test_output',
} as const;

export const SHAPED_WIRE_NAMES = {
  test: 'zephyr_run_tests',
  build: 'zephyr_build',
  lint: 'zephyr_lint',
  output: 'zephyr_test_output',
} as const;

/** What a harness calls the tool through the `zephyr` MCP server. */
export const SHAPED_HARNESS_NAMES = {
  test: 'mcp__zephyr__' + SHAPED_WIRE_NAMES.test,
  build: 'mcp__zephyr__' + SHAPED_WIRE_NAMES.build,
  lint: 'mcp__zephyr__' + SHAPED_WIRE_NAMES.lint,
  output: 'mcp__zephyr__' + SHAPED_WIRE_NAMES.output,
} as const;

export interface ShapedToolsOptions extends Omit<ShapedRunConfig, 'store'> {
  store?: OutputStore;
  worktrees?: RunWorktrees;
}

function descriptor(
  key: keyof typeof SHAPED_TOOL_IDS,
  description: string,
  effect: 'read' | 'write',
): ToolDescriptor {
  const id = SHAPED_TOOL_IDS[key];
  return {
    id,
    version: '1',
    providerId: 'zephyr',
    family: 'coding',
    description,
    inputSchemaRef: 'zephyr://schemas/' + id + '/1',
    transport: 'local',
    baselineEffect: effect,
    reversibility: 'reversible',
    requiredScopes: [],
    allowedDataLabels: ['public', 'private', 'secret', 'local_only'],
    availability: 'available',
    executorRef: 'local://' + id,
    executionMode: 'live',
  };
}

function text(value: Json, key: string): string | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = (value as Record<string, Json>)[key];
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

function integer(value: Json, key: string): number | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = (value as Record<string, Json>)[key];
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
  }
  return undefined;
}

function output(summary: string, labels: ToolExecutionOutput['dataLabels'], verified: boolean): ToolExecutionOutput {
  const publicOnly = labels.every((l) => l === 'public');
  return {
    output: { text: summary },
    summary,
    ...(publicOnly ? { sanitizedSummary: summary } : {}),
    dataLabels: [...labels],
    verified,
    executionMode: 'live',
  };
}

/** A failure the model can act on: thrown, so the broker records it as a failed call. */
export class ShapedToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(code + ': ' + message);
    this.name = 'ShapedToolError';
  }
}

export function registerShapedTools(
  registry: InMemoryToolRegistry,
  executors: InMemoryToolExecutorRegistry,
  options: ShapedToolsOptions = {},
): { store: OutputStore; worktrees: RunWorktrees } {
  const store = options.store ?? new OutputStore();
  const worktrees = options.worktrees ?? runWorktrees;
  const { store: _s, worktrees: _w, ...runConfig } = options;
  const cfg: ShapedRunConfig = { ...runConfig, store };

  const runners: { key: ShapedKind; description: string; filter: boolean }[] = [
    {
      key: 'test',
      description:
        "Run the project's tests in the run's worktree. Returns counts, every failing test id with a short " +
        'assertion and trace, and a handle; call zephyr_test_output(handle, testId) for a full failure. ' +
        'Use this instead of running the test command in a shell.',
      filter: true,
    },
    {
      key: 'build',
      description:
        "Build or typecheck the project in the run's worktree. Returns error and warning diagnostics " +
        '(file, line, code, message) and a handle for full output. Use this instead of a shell build.',
      filter: false,
    },
    {
      key: 'lint',
      description:
        "Lint the project in the run's worktree. Returns diagnostics and a handle for full output. " +
        'Use this instead of running the linter in a shell.',
      filter: false,
    },
  ];

  for (const runner of runners) {
    const d = descriptor(runner.key, runner.description, 'write');
    registry.register({
      descriptor: d,
      wireName: SHAPED_WIRE_NAMES[runner.key],
      inputSchema: runner.filter
        ? {
            type: 'object',
            properties: {
              filter: { type: 'string', description: 'Optional test name or path filter.' },
            },
            additionalProperties: false,
          }
        : { type: 'object', properties: {}, additionalProperties: false },
    });
    executors.register({
      ref: d.executorRef,
      destinationFor: () => 'local://zephyr/worktree',
      async execute(action, ctx) {
        const worktree = worktrees.resolve(action.runId);
        if (!worktree) {
          throw new ShapedToolError('NO_WORKTREE', 'This run has no coding worktree; shaped tools run only in coding runs.');
        }
        const filter = runner.filter ? text(action.arguments, 'filter') : undefined;
        const result = await runShaped(
          runner.key,
          {
            runId: action.runId,
            worktree,
            ...(filter !== undefined ? { filter } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          },
          cfg,
        );
        if (!result.ok) throw new ShapedToolError(result.code, result.message);
        return output(result.text, action.dataLabels, true);
      },
    });
  }

  const out = descriptor(
    'output',
    'Full detail behind a handle from zephyr_run_tests, zephyr_build or zephyr_lint: one failure by testId ' +
      '(or diagnostic id), or a page of the raw log when testId is omitted (use offset to page).',
    'read',
  );
  registry.register({
    descriptor: out,
    wireName: SHAPED_WIRE_NAMES.output,
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string' },
        testId: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
      },
      required: ['handle'],
      additionalProperties: false,
    },
  });
  executors.register({
    ref: out.executorRef,
    destinationFor: () => 'local://zephyr/output',
    async execute(action) {
      const handle = text(action.arguments, 'handle');
      if (!handle) throw new ShapedToolError('BAD_INPUT', 'handle is required.');
      const found = store.get(handle, action.runId, text(action.arguments, 'testId'), integer(action.arguments, 'offset'));
      if (!found.ok) throw new ShapedToolError(found.code, found.message);
      const header = found.id
        ? `${found.id}\n`
        : `chars ${found.offset}–${(found.offset ?? 0) + found.text.length} of ${found.totalChars}` +
          (found.nextOffset !== undefined ? ` (next offset ${found.nextOffset})` : '') +
          '\n';
      return output(header + found.text, action.dataLabels, true);
    },
  });

  return { store, worktrees };
}

/**
 * The shaped kinds a harness was actually offered, from the task's exposed tool
 * ids. Only these kinds have their raw shell form denied: a kind that is not
 * offered stays an ordinary shell command, so the agent is never left without a
 * way to test, build or lint.
 */
export function offeredShapedKinds(tools: readonly string[] | undefined): ShapedKind[] {
  if (!tools) return [];
  return (['test', 'build', 'lint'] as const).filter((kind) => tools.includes(SHAPED_TOOL_IDS[kind]));
}
