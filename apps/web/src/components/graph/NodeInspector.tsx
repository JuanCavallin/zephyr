/**
 * Node inspector -- Phase 4's edit surface.
 *
 * One typed form per node type, built straight off graphNodeSchema's config
 * variants in packages/shared/src/schemas/graph.ts (the source of truth for
 * every field name and constraint here). Two fields are a deliberate
 * exception and stay as validated JSON text rather than generated form
 * fields: `args` (tool/dispatch/submit) is a Record<string, Json> whose shape
 * is whatever the target tool defines -- there is no schema to build typed
 * inputs from until Person 3's tool registry reports per-tool argument shapes
 * (see toolNodeSchema.actionKind's TODO) -- and multi-line string lists
 * (swarm.items, judge.options) use one-value-per-line text areas rather than
 * dynamic add/remove rows, which is still a typed array field, just a terser
 * editor for it.
 *
 * Every field commits through `patchNode`, which merges shallowly into the
 * existing config server-side (graphs.service.ts) -- so a save here only
 * needs to send the field(s) that changed, never the whole config.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { PROVIDER_IDS, type AgentGraph, type GraphNode, styleOf } from '@htn/shared';
import { api } from '../../lib/api';
import type { ToolCatalogEntry } from '../../hooks/useTools';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';

const inputClass =
  'w-full rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none';
const labelClass = 'text-[11px] uppercase tracking-wide text-slate-500';

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className={labelClass}>{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-slate-600">{hint}</span>}
    </label>
  );
}

function ToolMultiSelect({
  tools,
  selected,
  onChange,
}: {
  tools: ToolCatalogEntry[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  if (tools.length === 0) {
    return (
      <textarea
        className={inputClass + ' min-h-[4rem] font-mono'}
        defaultValue={selected.join('\n')}
        placeholder="one tool name per line"
        onBlur={(event) =>
          onChange(
            event.target.value
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
          )
        }
      />
    );
  }
  return (
    <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-slate-700 bg-slate-900 p-2">
      {tools.map((tool) => (
        <label
          key={tool.name}
          className="flex items-center gap-2 rounded px-1 py-0.5 text-xs text-slate-300 hover:bg-slate-800"
          title={tool.description}
        >
          <input
            type="checkbox"
            checked={selected.includes(tool.name)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...selected, tool.name]
                  : selected.filter((name) => name !== tool.name),
              )
            }
          />
          <span className="truncate font-mono">{tool.name}</span>
        </label>
      ))}
    </div>
  );
}

/** `args`-shaped fields: validated-JSON textarea. See file header for why. */
function JsonField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: unknown;
  onCommit: (next: unknown) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setText(JSON.stringify(value ?? {}, null, 2)), [value]);

  return (
    <Field label={label} hint={error ?? 'JSON object'}>
      <textarea
        className={inputClass + ' min-h-[5rem] font-mono' + (error ? ' border-rose-600' : '')}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          try {
            const parsed = JSON.parse(text || '{}');
            setError(null);
            onCommit(parsed);
          } catch {
            setError('Invalid JSON -- not saved');
          }
        }}
      />
    </Field>
  );
}

function LineListField({
  label,
  hint,
  value,
  onCommit,
}: {
  label: string;
  hint?: string;
  value: string[];
  onCommit: (next: string[]) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <textarea
        className={inputClass + ' min-h-[4rem] font-mono'}
        defaultValue={value.join('\n')}
        onBlur={(event) =>
          onCommit(
            event.target.value
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
          )
        }
      />
    </Field>
  );
}

export interface NodeInspectorProps {
  graph: AgentGraph;
  node: GraphNode;
  tools: ToolCatalogEntry[];
  onPatched: (graph: AgentGraph) => void;
  onDeleted: (graph: AgentGraph) => void;
  onError: (message: string) => void;
}

export function NodeInspector({
  graph,
  node,
  tools,
  onPatched,
  onDeleted,
  onError,
}: NodeInspectorProps) {
  const style = styleOf(node.type);
  const [deleting, setDeleting] = useState(false);

  async function save(patch: {
    label?: string;
    background?: boolean;
    config?: Record<string, unknown>;
  }) {
    try {
      // Config's shape is narrowed per node.type server-side (patchNode merges
      // it into the existing, already-typed config); the client only ever
      // sends the fields for the type it's currently rendering, same as the
      // `patch as never` cast at the API boundary in graphs.routes.ts.
      const { graph: next } = await api.patchNode(graph.id, node.id, patch as never, graph.version);
      onPatched(next);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove() {
    setDeleting(true);
    try {
      const { graph: next } = await api.removeNode(graph.id, node.id, graph.version);
      onDeleted(next);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>{style.icon}</span>
        <Badge tone="accent">{style.label}</Badge>
        <span className="font-mono text-xs text-slate-400">{node.type}</span>
        {style.opaque && (
          <Badge tone="warn" title="This runtime's internal loop is not visible to us">
            opaque
          </Badge>
        )}
        <Button
          variant="danger"
          className="ml-auto !px-2 !py-1 text-xs"
          disabled={deleting}
          onClick={() => void remove()}
        >
          {deleting ? 'Deleting…' : 'Delete node'}
        </Button>
      </div>

      <p className="text-xs text-slate-500">{style.description}</p>

      <Field label="Label">
        <input
          className={inputClass}
          defaultValue={node.label}
          onBlur={(event) => {
            if (event.target.value.trim() && event.target.value !== node.label) {
              save({ label: event.target.value.trim() });
            }
          }}
        />
      </Field>

      <label className="flex items-center gap-2 text-xs text-slate-400">
        <input
          type="checkbox"
          checked={node.background ?? false}
          onChange={(event) => save({ background: event.target.checked })}
        />
        Background (don&apos;t block downstream nodes that don&apos;t depend on it)
      </label>

      <TypeFields node={node} tools={tools} onCommit={(config) => save({ config })} />
    </div>
  );
}

function TypeFields({
  node,
  tools,
  onCommit,
}: {
  node: GraphNode;
  tools: ToolCatalogEntry[];
  onCommit: (config: Record<string, unknown>) => void;
}) {
  switch (node.type) {
    case 'fetch':
      return (
        <>
          <Field
            label="Source"
            hint="Opaque to the runtime -- a URL, a variable ref, or a name it resolves"
          >
            <input
              className={inputClass}
              defaultValue={node.config.source}
              onBlur={(e) => e.target.value.trim() && onCommit({ source: e.target.value.trim() })}
            />
          </Field>
          <Field label="Literal text (optional)" hint="Supports {{refs}} into run variables">
            <textarea
              className={inputClass + ' min-h-[4rem]'}
              defaultValue={node.config.text ?? ''}
              onBlur={(e) => onCommit({ text: e.target.value || undefined })}
            />
          </Field>
        </>
      );

    case 'tool':
      return (
        <>
          <ToolNameField
            value={node.config.tool}
            tools={tools}
            onCommit={(tool) => onCommit({ tool })}
          />
          <JsonField
            label="Args"
            value={node.config.args}
            onCommit={(args) => onCommit({ args })}
          />
          <ActionKindField value={node.config.actionKind} onCommit={onCommit} />
        </>
      );

    case 'dispatch':
      return (
        <>
          <Field label="Goal" hint="Handed to the decision layer as the question">
            <textarea
              className={inputClass + ' min-h-[3rem]'}
              defaultValue={node.config.goal}
              onBlur={(e) => e.target.value.trim() && onCommit({ goal: e.target.value.trim() })}
            />
          </Field>
          <Field label="Candidate tools" hint="The decision layer picks exactly one">
            <ToolMultiSelect
              tools={tools}
              selected={node.config.candidateTools}
              onChange={(candidateTools) =>
                candidateTools.length >= 2 && onCommit({ candidateTools })
              }
            />
          </Field>
          <Field label="Argument source">
            <select
              className={inputClass}
              value={node.config.argsFrom}
              onChange={(e) => onCommit({ argsFrom: e.target.value })}
            >
              <option value="static">static -- use the args below, zero extra tokens</option>
              <option value="model">model -- one extra completion infers the args</option>
            </select>
          </Field>
          {node.config.argsFrom === 'model' && (
            <>
              <Field
                label="Argument model tier"
                hint="Only affects how arguments are generated, not which tool is picked."
              >
                <select
                  className={inputClass}
                  value={node.config.argsModelTier ?? ''}
                  onChange={(e) => onCommit({ argsModelTier: e.target.value || undefined })}
                >
                  <option value="">default (cheap)</option>
                  <option value="cheap">cheap</option>
                  <option value="standard">standard</option>
                  <option value="frontier">frontier</option>
                </select>
              </Field>
              <Field
                label="Argument temperature (optional)"
                hint="Only affects how arguments are generated, not which tool is picked."
              >
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.1}
                  className={inputClass}
                  defaultValue={node.config.argsTemperature ?? ''}
                  onBlur={(e) =>
                    onCommit({
                      argsTemperature: e.target.value ? Number(e.target.value) : undefined,
                    })
                  }
                />
              </Field>
            </>
          )}
          <JsonField
            label="Args per candidate tool"
            value={node.config.args}
            onCommit={(args) => onCommit({ args })}
          />
          <Field label="Evidence (optional)">
            <textarea
              className={inputClass + ' min-h-[3rem]'}
              defaultValue={node.config.evidence ?? ''}
              onBlur={(e) => onCommit({ evidence: e.target.value || undefined })}
            />
          </Field>
          <ActionKindField value={node.config.actionKind} onCommit={onCommit} />
        </>
      );

    case 'redact':
      return (
        <>
          <Field label="Field" hint="Provenance label recorded on every PII span this produces">
            <input
              className={inputClass}
              defaultValue={node.config.field}
              onBlur={(e) => e.target.value.trim() && onCommit({ field: e.target.value.trim() })}
            />
          </Field>
          <Field label="Text (optional)">
            <textarea
              className={inputClass + ' min-h-[4rem]'}
              defaultValue={node.config.text ?? ''}
              onBlur={(e) => onCommit({ text: e.target.value || undefined })}
            />
          </Field>
        </>
      );

    case 'decide':
      return (
        <>
          <Field label="Prompt">
            <textarea
              className={inputClass + ' min-h-[4rem]'}
              defaultValue={node.config.prompt}
              onBlur={(e) => e.target.value.trim() && onCommit({ prompt: e.target.value.trim() })}
            />
          </Field>
          <Field label="System prompt (optional)">
            <textarea
              className={inputClass + ' min-h-[3rem]'}
              defaultValue={node.config.system ?? ''}
              onBlur={(e) => onCommit({ system: e.target.value || undefined })}
            />
          </Field>
          <Field label="Model tier">
            <select
              className={inputClass}
              value={node.config.tier ?? ''}
              onChange={(e) => onCommit({ tier: e.target.value || undefined })}
            >
              <option value="">default (standard)</option>
              <option value="cheap">cheap</option>
              <option value="standard">standard</option>
              <option value="frontier">frontier</option>
            </select>
          </Field>
          <Field label="Max tokens (optional)">
            <input
              type="number"
              min={1}
              max={8192}
              className={inputClass}
              defaultValue={node.config.maxTokens ?? ''}
              onBlur={(e) =>
                onCommit({ maxTokens: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </Field>
          <Field label="Temperature (optional)">
            <input
              type="number"
              min={0}
              max={1}
              step={0.1}
              className={inputClass}
              defaultValue={node.config.temperature ?? ''}
              onBlur={(e) =>
                onCommit({ temperature: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </Field>
        </>
      );

    case 'agent_task':
      return (
        <>
          <Field label="Goal" hint="The subtask handed to the agent runtime">
            <textarea
              className={inputClass + ' min-h-[4rem]'}
              defaultValue={node.config.goal}
              onBlur={(e) => e.target.value.trim() && onCommit({ goal: e.target.value.trim() })}
            />
          </Field>
          <Field
            label="Available tools"
            hint="The CANDIDATE list -- the decision layer filters this before the harness starts"
          >
            <ToolMultiSelect
              tools={tools}
              selected={node.config.availableTools}
              onChange={(availableTools) => onCommit({ availableTools })}
            />
          </Field>
          <Field
            label="Harness"
            hint='Only "hermes" is wired to actually run today -- leave unset to default correctly'
          >
            <select
              className={inputClass}
              value={node.config.harness ?? ''}
              onChange={(e) => onCommit({ harness: e.target.value || undefined })}
            >
              <option value="">default (hermes)</option>
              {PROVIDER_IDS.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </Field>
          <details className="rounded-md border border-slate-800 p-2">
            <summary className="cursor-pointer text-[11px] uppercase tracking-wide text-slate-500">
              Advanced (polling)
            </summary>
            <div className="mt-2 space-y-3">
              <Field label="Poll interval (ms)">
                <input
                  type="number"
                  min={100}
                  max={60_000}
                  className={inputClass}
                  defaultValue={node.config.pollIntervalMs ?? ''}
                  onBlur={(e) =>
                    onCommit({
                      pollIntervalMs: e.target.value ? Number(e.target.value) : undefined,
                    })
                  }
                />
              </Field>
              <Field label="Max polls" hint="Absolute safety ceiling">
                <input
                  type="number"
                  min={1}
                  max={2000}
                  className={inputClass}
                  defaultValue={node.config.maxPolls ?? ''}
                  onBlur={(e) =>
                    onCommit({ maxPolls: e.target.value ? Number(e.target.value) : undefined })
                  }
                />
              </Field>
              <Field
                label="Inactivity timeout (ms)"
                hint="Gives up only once the runtime goes silent this long"
              >
                <input
                  type="number"
                  min={1000}
                  max={1_800_000}
                  className={inputClass}
                  defaultValue={node.config.inactivityTimeoutMs ?? ''}
                  onBlur={(e) =>
                    onCommit({
                      inactivityTimeoutMs: e.target.value ? Number(e.target.value) : undefined,
                    })
                  }
                />
              </Field>
              <Field label="Max duration (ms)" hint="Stop the task after this many ms">
                <input
                  type="number"
                  min={1000}
                  max={1_800_000}
                  className={inputClass}
                  defaultValue={node.config.maxDurationMs ?? ''}
                  onBlur={(e) =>
                    onCommit({
                      maxDurationMs: e.target.value ? Number(e.target.value) : undefined,
                    })
                  }
                />
              </Field>
              <Field label="Max failed tool calls" hint="Stop after this many failed tool calls">
                <input
                  type="number"
                  min={0}
                  max={100}
                  className={inputClass}
                  defaultValue={node.config.maxFailedToolCalls ?? ''}
                  onBlur={(e) =>
                    onCommit({
                      maxFailedToolCalls: e.target.value ? Number(e.target.value) : undefined,
                    })
                  }
                />
              </Field>
            </div>
          </details>
        </>
      );

    case 'swarm':
      return (
        <>
          <LineListField
            label="Items"
            hint="One work item per line -- each becomes one worker"
            value={node.config.items}
            onCommit={(items) => items.length >= 1 && onCommit({ items })}
          />
          <Field label="Concurrency (optional, 1-16)">
            <input
              type="number"
              min={1}
              max={16}
              className={inputClass}
              defaultValue={node.config.concurrency ?? ''}
              onBlur={(e) =>
                onCommit({ concurrency: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </Field>
          <Field label="Worker prompt (optional)">
            <textarea
              className={inputClass + ' min-h-[3rem]'}
              defaultValue={node.config.workerPrompt ?? ''}
              onBlur={(e) => onCommit({ workerPrompt: e.target.value || undefined })}
            />
          </Field>
          <ToolNameField
            label="Worker tool (optional)"
            value={node.config.workerTool ?? ''}
            tools={tools}
            allowEmpty
            onCommit={(workerTool) => onCommit({ workerTool: workerTool || undefined })}
          />
        </>
      );

    case 'judge':
      return (
        <>
          <Field label="Question">
            <textarea
              className={inputClass + ' min-h-[3rem]'}
              defaultValue={node.config.question}
              onBlur={(e) => e.target.value.trim() && onCommit({ question: e.target.value.trim() })}
            />
          </Field>
          <LineListField
            label="Options"
            hint="One per line, at least two -- outgoing edges select a branch by option"
            value={node.config.options}
            onCommit={(options) => options.length >= 2 && onCommit({ options })}
          />
          <Field label="Evidence (optional)">
            <textarea
              className={inputClass + ' min-h-[3rem]'}
              defaultValue={node.config.evidence ?? ''}
              onBlur={(e) => onCommit({ evidence: e.target.value || undefined })}
            />
          </Field>
        </>
      );

    case 'submit':
      return (
        <>
          <ToolNameField
            value={node.config.tool}
            tools={tools}
            onCommit={(tool) => onCommit({ tool })}
          />
          <JsonField
            label="Args"
            value={node.config.args}
            onCommit={(args) => onCommit({ args })}
          />
          <Field label="Description" hint="Shown VERBATIM in the approval panel">
            <textarea
              className={inputClass + ' min-h-[3rem]'}
              defaultValue={node.config.description}
              onBlur={(e) =>
                e.target.value.trim() && onCommit({ description: e.target.value.trim() })
              }
            />
          </Field>
          <Field label="Amount, in cents (optional)">
            <input
              type="number"
              className={inputClass}
              defaultValue={node.config.amountCents ?? ''}
              onBlur={(e) =>
                onCommit({ amountCents: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </Field>
          <ActionKindField value={node.config.actionKind} onCommit={onCommit} />
        </>
      );

    case 'approval':
      return (
        <>
          <Field label="Description" hint="Shown VERBATIM in the approval panel">
            <textarea
              className={inputClass + ' min-h-[3rem]'}
              defaultValue={node.config.description}
              onBlur={(e) =>
                e.target.value.trim() && onCommit({ description: e.target.value.trim() })
              }
            />
          </Field>
          <Field label="Amount, in cents (optional)">
            <input
              type="number"
              className={inputClass}
              defaultValue={node.config.amountCents ?? ''}
              onBlur={(e) =>
                onCommit({ amountCents: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </Field>
        </>
      );

    case 'handoff':
      return (
        <>
          <div className="rounded border border-rose-500/30 bg-rose-500/5 px-2.5 py-2 text-[11px] leading-relaxed text-rose-200/80">
            The agent never performs this step. A person acts directly in the live browser, and
            nothing they type passes through this system — there is no field here to put a secret
            in, by design.
          </div>
          <Field
            label="Instruction"
            hint="Shown VERBATIM to the person. Say what to do, and that we cannot see it."
          >
            <textarea
              className={inputClass + ' min-h-[3rem]'}
              defaultValue={node.config.instruction}
              onBlur={(e) =>
                e.target.value.trim() && onCommit({ instruction: e.target.value.trim() })
              }
            />
          </Field>
          <Field label="Open at URL (optional)" hint="Leave blank to take over an existing session">
            <input
              className={inputClass}
              defaultValue={node.config.url ?? ''}
              onBlur={(e) => onCommit({ url: e.target.value.trim() || undefined })}
            />
          </Field>
          <Field
            label="Reuse session (optional)"
            hint='A ref such as "{{open_portal.sessionId}}". Set this instead of a URL.'
          >
            <input
              className={inputClass}
              defaultValue={node.config.sessionId ?? ''}
              onBlur={(e) => onCommit({ sessionId: e.target.value.trim() || undefined })}
            />
          </Field>
          <Field label="Resume when">
            <select
              className={inputClass}
              value={node.config.resumeWhen}
              onChange={(e) => onCommit({ resumeWhen: e.target.value })}
            >
              <option value="human_confirms">the person clicks Done</option>
              <option value="url_matches">the page reaches an expected URL</option>
            </select>
          </Field>
          {node.config.resumeWhen === 'url_matches' && (
            <Field label="Expected URL" hint="Matched as a prefix">
              <input
                className={inputClass}
                defaultValue={node.config.expectUrl ?? ''}
                onBlur={(e) => onCommit({ expectUrl: e.target.value.trim() || undefined })}
              />
            </Field>
          )}
          <Field
            label="Timeout, ms (optional)"
            hint="Fails the run. It never falls through to letting the agent try."
          >
            <input
              type="number"
              min={5000}
              className={inputClass}
              defaultValue={node.config.timeoutMs ?? ''}
              onBlur={(e) =>
                onCommit({ timeoutMs: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </Field>
        </>
      );
  }
}

function ToolNameField({
  label = 'Tool',
  value,
  tools,
  allowEmpty = false,
  onCommit,
}: {
  label?: string;
  value: string;
  tools: ToolCatalogEntry[];
  allowEmpty?: boolean;
  onCommit: (tool: string) => void;
}) {
  if (tools.length === 0) {
    return (
      <Field label={label}>
        <input
          className={inputClass + ' font-mono'}
          defaultValue={value}
          onBlur={(e) => (allowEmpty || e.target.value.trim()) && onCommit(e.target.value.trim())}
        />
      </Field>
    );
  }
  return (
    <Field label={label}>
      <select
        className={inputClass + ' font-mono'}
        value={value}
        onChange={(e) => onCommit(e.target.value)}
      >
        {allowEmpty && <option value="">(none)</option>}
        {!tools.some((t) => t.name === value) && value && (
          <option value={value}>
            {value}
            {value.startsWith('browserbase.') ? ' · Deprecated compatibility' : ''}
          </option>
        )}
        {tools.map((tool) => (
          <option key={tool.name} value={tool.name} title={tool.description}>
            {tool.name}
            {tool.name.startsWith('browserbase.') ? ' · Deprecated compatibility' : ''}
          </option>
        ))}
      </select>
    </Field>
  );
}

function ActionKindField({
  value,
  onCommit,
}: {
  value: string | undefined;
  onCommit: (config: Record<string, unknown>) => void;
}) {
  return (
    <Field
      label="Action kind (optional)"
      hint="What this call DOES, e.g. read_page, send_email, submit_form -- drives the approval gate"
    >
      <input
        className={inputClass + ' font-mono'}
        defaultValue={value ?? ''}
        onBlur={(e) => onCommit({ actionKind: e.target.value.trim() || undefined })}
      />
    </Field>
  );
}
