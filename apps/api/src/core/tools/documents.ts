import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { ActionPreview, Json, ToolAction, ToolDescriptor } from '@htn/shared';
import type { InMemoryToolRegistry } from './registry.js';
import type { InMemoryToolExecutorRegistry, ToolExecutionOutput } from './executors.js';

function version(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
function asObject(args: Json): Record<string, Json> {
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new Error('Document arguments require an object.');
  return args;
}

/** Local, real bounded artifacts for reviewed drafts; does not pretend to automate Office. */
export function registerDocumentTools(
  registry: InMemoryToolRegistry,
  executors: InMemoryToolExecutorRegistry,
  options: { root?: string; mode?: 'live' | 'mock' } = {},
): void {
  const root = resolve(options.root ?? '.data/action-artifacts');
  const mock = options.mode === 'mock';
  const memory = new Map<string, string>();
  function target(action: ToolAction): string {
    const args = asObject(action.arguments);
    if (
      !/^[a-zA-Z0-9_-]{1,100}$/.test(action.runId) ||
      typeof args.artifactId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(args.artifactId)
    )
      throw new Error('Invalid run/artifact identity.');
    const file = resolve(
      root,
      action.runId,
      args.artifactId + (action.toolId.includes('spreadsheet') ? '.json' : '.md'),
    );
    if (!file.startsWith(root + sep)) throw new Error('Artifact escapes local storage.');
    return file;
  }
  async function read(action: ToolAction): Promise<string | null> {
    const file = target(action);
    if (mock) return memory.get(file) ?? null;
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  for (const kind of ['document', 'spreadsheet'] as const)
    for (const operation of ['read', 'update'] as const) {
      const id = 'agentos.' + kind + '_' + operation;
      const write = operation === 'update';
      const descriptor: ToolDescriptor = {
        id,
        version: '1',
        providerId: 'hermes',
        family: kind,
        description:
          (write ? 'Update a reviewed local ' : 'Read metadata about a local ') +
          kind +
          ' artifact in this run. Spreadsheet artifacts store JSON cell grids, not Office workbooks.',
        inputSchemaRef: 'local://schemas/' + id,
        transport: 'local',
        baselineEffect: write ? 'write' : 'read',
        reversibility: write ? 'recoverable' : 'reversible',
        requiresChangeReview: write,
        requiredScopes: [],
        allowedDataLabels: ['public', 'private', 'secret', 'local_only'],
        availability: 'available',
        executorRef: 'local://' + id,
      };
      const properties: Record<string, Json> = {
        artifactId: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$' },
      };
      if (write) {
        properties.expectedVersion = { type: 'string', minLength: 1, maxLength: 64 };
        if (kind === 'document') properties.content = { type: 'string', maxLength: 24000 };
        else
          properties.values = {
            type: 'array',
            maxItems: 100,
            items: {
              type: 'array',
              maxItems: 50,
              items: {
                anyOf: [
                  { type: 'string', maxLength: 2000 },
                  { type: 'number' },
                  { type: 'boolean' },
                  { type: 'null' },
                ],
              },
            },
          };
      }
      descriptor.executionMode = mock ? 'mock' : 'live';
      registry.register({
        descriptor,
        inputSchema: {
          type: 'object',
          properties,
          required: write
            ? ['artifactId', 'expectedVersion', kind === 'document' ? 'content' : 'values']
            : ['artifactId'],
          additionalProperties: false,
        },
      });
      executors.register({
        ref: descriptor.executorRef,
        destinationFor: ({ arguments: args }) =>
          'local://artifacts/' + kind + '/' + String(asObject(args).artifactId),
        ...(write
          ? {
              validateResourceVersion: async (action: ToolAction) => {
                const before = await read(action);
                if (
                  asObject(action.arguments).expectedVersion !==
                  (before === null ? 'new' : version(before))
                )
                  throw new Error(
                    'RESOURCE_CONFLICT: artifact changed; read its version and request fresh approval.',
                  );
              },
            }
          : {}),
        async execute(action): Promise<ToolExecutionOutput> {
          const args = asObject(action.arguments);
          const before = await read(action);
          if (!write)
            return {
              output: {
                artifactId: args.artifactId,
                exists: before !== null,
                version: before === null ? 'new' : version(before),
              },
              summary: 'Read local ' + kind + ' metadata.',
              dataLabels: [...action.dataLabels],
              verified: true,
              evidenceVerified: !mock,
              executionMode: mock ? 'mock' : 'live',
            };
          const beforeCells =
            kind === 'spreadsheet' && before !== null ? (JSON.parse(before) as Json[][]) : null;
          const after = kind === 'document' ? String(args.content) : JSON.stringify(args.values);
          if (Buffer.byteLength(after) > 24000)
            throw new Error('Artifact exceeds the local preview budget.');
          const file = target(action);
          if (mock) memory.set(file, after);
          else {
            await mkdir(resolve(file, '..'), { recursive: true });
            const tmp = file + '.' + action.id + '.tmp';
            await writeFile(tmp, after, { encoding: 'utf8', flag: 'wx' });
            await rename(tmp, file);
          }
          const actual = await read(action);
          if (actual !== after)
            throw new Error(
              'LOCAL_READBACK_FAILED: resulting artifact differs from approved content.',
            );
          const changes =
            kind === 'document'
              ? [
                  {
                    location: String(args.artifactId),
                    ...(before === null ? {} : { before }),
                    after,
                  },
                ]
              : (args.values as Json[][]).flatMap((row, i) =>
                  row.map((value, j) => ({
                    location: 'Row ' + (i + 1) + ', column ' + (j + 1),
                    ...(beforeCells === null ? {} : { before: beforeCells[i]?.[j] ?? null }),
                    after: value,
                  })),
                );
          const preview: ActionPreview = {
            kind,
            title: String(args.artifactId),
            arguments: { artifactId: args.artifactId },
            changes: changes.slice(0, 200),
            truncated: changes.length > 200,
            baseVersion: before === null ? 'new' : version(before),
          };
          return {
            output: {
              artifactId: args.artifactId,
              version: version(after),
              bytes: Buffer.byteLength(after),
              format: kind === 'document' ? 'markdown' : 'json_cell_grid',
            },
            summary:
              (mock ? 'Mock updated ' : 'Updated and read back local ') +
              kind +
              ' ' +
              args.artifactId +
              '.',
            dataLabels: [...action.dataLabels],
            verified: true,
            evidenceVerified: !mock,
            executionMode: mock ? 'mock' : 'live',
            executedPreview: preview,
          };
        },
      });
    }
}
